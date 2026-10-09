"""
Eligibility Checker Lambda (Durable Execution)

Invoked asynchronously from the Connect contact flow after the InTakeAgent
collects caller information. Uses durable execution steps for reliability.

Steps:
1. Check eligibility based on medicare status, state, and DOB
2. Verify address & phone in parallel using Amazon Location Service + area code lookup
3. Assess fraud likelihood using Bedrock (enhanced with verification results)
4. Store contact record with all results in DynamoDB
5. If HIGH risk: create callback and wait for supervisor approval
6. Update record with supervisor decision
"""

import json
import os
import re
from datetime import datetime, date
from decimal import Decimal
from typing import Any, Dict

import boto3
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.metrics import MetricUnit
from aws_durable_execution_sdk_python import durable_execution, DurableContext, durable_step, StepContext
from aws_durable_execution_sdk_python.config import StepConfig, Duration, ParallelConfig
from aws_durable_execution_sdk_python.retries import RetryStrategyConfig, create_retry_strategy
from lab3_helpers import check_eligibility_step
from lab4_and_5_helpers import assess_fraud_with_address_verification_step, store_contact_record_with_address_step, verify_phone_area_code_step

logger = Logger()
tracer = Tracer()
metrics = Metrics()

dynamodb = boto3.resource('dynamodb')
bedrock_runtime = boto3.client('bedrock-runtime')
# Client used to call Amazon Location (This is used in Lab 4)
location_client = boto3.client('geo-places')

CONTACTS_TABLE = os.environ.get('CONTACTS_TABLE', 'sca-analytics')
BEDROCK_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')


@durable_step
def verify_address_step(step_ctx: StepContext, attrs: Dict[str, str]) -> Dict[str, Any]:
    """Durable step: Verify address and state using Amazon Location Service."""
    address = attrs.get('residentialAddress', '')
    stated_state = (attrs.get('inTakeAgentState') or attrs.get('state') or '').upper().strip()

    if not address:
        return {
            'verified': False,
            'reason': 'No address provided',
            'geocodedState': None,
            'stateMatch': False,
            'confidence': 0.0,
        }

    try:
        response = location_client.geocode(
            QueryText=address,
            MaxResults=1,
            Filter={'IncludeCountries': ['USA']},
        )

        results = response.get('ResultItems', [])
        if not results:
            return {
                'verified': False,
                'reason': 'Address not found',
                'geocodedState': None,
                'stateMatch': False,
                'confidence': 0.0,
            }

        result = results[0]
        place = result.get('Address', {})
        geocoded_state = (place.get('Region', {}).get('Code', '') or '').upper().strip()
        confidence = result.get('Relevance', 0.0)

        # Compare geocoded state with stated state (both are 2-letter codes)
        state_match = stated_state.upper().strip() == geocoded_state.upper().strip()

        logger.info("Address verification completed", extra={
            "geocodedState": geocoded_state,
            "statedState": stated_state,
            "stateMatch": state_match,
            "confidence": confidence,
        })

        return {
            'verified': True,
            'geocodedState': geocoded_state,
            'stateMatch': state_match,
            'confidence': confidence,
            'formattedAddress': place.get('Label', address),
            'reason': 'Address verified' if state_match else f'State mismatch: stated {stated_state}, geocoded {geocoded_state}',
        }

    except Exception as e:
        logger.error(f"Address verification failed: {e}")
        return {
            'verified': False,
            'reason': f'Verification failed: {str(e)}',
            'geocodedState': None,
            'stateMatch': False,
            'confidence': 0.0,
        }


@durable_step
def save_callback_id_step(step_ctx: StepContext, contact_id: str, callback_id: str) -> Dict[str, str]:
    """Durable step: Store callback ID in DynamoDB so the CRM API can retrieve it."""
    table = dynamodb.Table(CONTACTS_TABLE)
    table.update_item(
        Key={'PK': contact_id, 'SK': 'CONTACT#DETAILS'},
        UpdateExpression='SET callbackId = :cid',
        ExpressionAttributeValues={':cid': callback_id},
    )
    logger.info("Callback ID stored", extra={"contactId": contact_id, "callbackId": callback_id})
    return {'status': 'callback_saved', 'callbackId': callback_id}


@durable_step
def update_review_decision_step(step_ctx: StepContext, contact_id: str, decision: Dict[str, Any]) -> Dict[str, str]:
    """Durable step: Update contact record with supervisor decision."""
    table = dynamodb.Table(CONTACTS_TABLE)
    now = datetime.utcnow().isoformat()
    table.update_item(
        Key={'PK': contact_id, 'SK': 'CONTACT#DETAILS'},
        UpdateExpression='SET reviewStatus = :rs, reviewDecision = :rd, reviewedAt = :ra, updatedAt = :ua REMOVE callbackId',
        ExpressionAttributeValues={
            ':rs': decision.get('action', 'DENIED'),
            ':rd': {
                'action': decision.get('action', 'DENIED'),
                'reviewer': decision.get('reviewer', 'unknown'),
                'reason': decision.get('reason', ''),
            },
            ':ra': now,
            ':ua': now,
        },
    )
    logger.info("Review decision stored", extra={
        "contactId": contact_id,
        "action": decision.get('action'),
    })
    return {'status': 'decision_stored', 'action': decision.get('action')}


@durable_execution
def lambda_handler(event: Dict[str, Any], context: DurableContext) -> Dict[str, Any]:
    """
    Invoked asynchronously by Connect contact flow.
    Uses durable execution context.step() for each operation.
    """
    logger.info("Eligibility check invoked", extra={"event_keys": list(event.keys())})

    details = event.get('Details', {})
    contact_data = details.get('ContactData', {})
    contact_id = contact_data.get('ContactId', '')
    attrs = contact_data.get('Attributes', {})

    logger.info("Processing eligibility", extra={
        "contactId": contact_id,
        "state": attrs.get('inTakeAgentState'),
        "medicareEligible": attrs.get('medicareEligible'),
    })

    # Configure retry strategy for durable steps
    retry_config = RetryStrategyConfig(
        max_attempts=3,
        initial_delay=Duration.from_seconds(2),
        backoff_rate=2.0,
        max_delay=Duration.from_seconds(30),
    )
    step_config = StepConfig(retry_strategy=create_retry_strategy(retry_config))

    # Durable Step 1: Check eligibility
    eligibility = context.step(
        check_eligibility_step(attrs),
        name=f'check_eligibility_{contact_id}',
        config=step_config
    )

    logger.info("Eligibility result", extra={
        "contactId": contact_id,
        "eligible": eligibility['eligible'],
        "plans": eligibility['plans'],
    })

    # Durable Step 2: Run address + phone verification in parallel
    def run_address_check(ctx):
        return ctx.step(
            verify_address_step(attrs),
            name=f'verify_address_{contact_id}',
            config=step_config
        )

    def run_phone_check(ctx):
        return ctx.step(
            verify_phone_area_code_step(attrs),
            name=f'verify_phone_{contact_id}',
            config=step_config
        )

    verification_results = context.parallel(
        [run_address_check, run_phone_check],
        name=f'verify_caller_{contact_id}',
        config=ParallelConfig(max_concurrency=2)
    )

    address_verification, phone_verification = verification_results.get_results()

    logger.info("Parallel verification completed", extra={
        "contactId": contact_id,
        "addressVerified": address_verification.get('verified'),
        "addressStateMatch": address_verification.get('stateMatch'),
        "phoneStateMatch": phone_verification.get('stateMatch'),
    })

    # Durable Step 3: Assess fraud likelihood via Bedrock (enhanced with verification results)
    fraud_assessment = context.step(
        assess_fraud_with_address_verification_step(attrs, eligibility, address_verification, phone_verification),
        name=f'assess_fraud_{contact_id}',
        config=step_config
    )

    logger.info("Fraud assessment result", extra={
        "contactId": contact_id,
        "riskLevel": fraud_assessment.get('risk_level'),
        "riskScore": fraud_assessment.get('risk_score'),
    })

    # Durable Step 4: Store contact record with all results
    context.step(
        store_contact_record_with_address_step(contact_id, attrs, eligibility, address_verification, fraud_assessment),
        name=f'store_contact_{contact_id}',
        config=step_config
    )

    logger.info("Contact record stored", extra={"contactId": contact_id})

    # Durable Step 5: Supervisor callback for HIGH risk cases
    if fraud_assessment.get('risk_level') == 'HIGH':
        logger.info("HIGH risk detected — creating supervisor callback", extra={"contactId": contact_id})

        callback = context.create_callback(name=f'supervisor_review_{contact_id}')

        # Store the callback_id so the CRM API can send the decision
        context.step(
            save_callback_id_step(contact_id, callback.callback_id),
            name=f'save_callback_{contact_id}',
            config=step_config
        )

        # SUSPEND — execution pauses here until supervisor responds ($0 compute cost)
        decision = callback.result()
        if isinstance(decision, str):
            decision = json.loads(decision)

        logger.info("Supervisor decision received", extra={
            "contactId": contact_id,
            "decision": decision,
        })

        # Durable Step 6: Update record with supervisor decision
        context.step(
            update_review_decision_step(contact_id, decision),
            name=f'update_decision_{contact_id}',
            config=step_config
        )

    metrics.add_metric(name="EligibilityChecked", unit=MetricUnit.Count, value=1)
    if eligibility['eligible']:
        metrics.add_metric(name="EligibleContacts", unit=MetricUnit.Count, value=1)
    if fraud_assessment.get('risk_level') == 'HIGH':
        metrics.add_metric(name="HighRiskContacts", unit=MetricUnit.Count, value=1)

    return {
        'eligible': eligibility['eligible'],
        'plans': eligibility['plans'],
        'reason': eligibility['reason'],
        'addressVerified': address_verification.get('stateMatch', False),
        'fraudRiskLevel': fraud_assessment.get('risk_level', 'UNKNOWN'),
    }
