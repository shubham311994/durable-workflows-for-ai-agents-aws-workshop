"""
Eligibility Checker Lambda (Durable Execution)

Invoked asynchronously from the Connect contact flow after the InTakeAgent
collects caller information. Uses durable execution steps for reliability.

Steps:
1. Check eligibility based on medicare status, state, and DOB
2. Assess fraud likelihood using Bedrock
3. Store contact record with eligibility and fraud assessment in DynamoDB
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
from lab3_helpers import check_eligibility_step, assess_fraud_step, store_contact_record_step
from lab4_and_5_helpers import assess_fraud_with_address_verification_step, store_contact_record_with_address_step

logger = Logger()
tracer = Tracer()
metrics = Metrics()

dynamodb = boto3.resource('dynamodb')
bedrock_runtime = boto3.client('bedrock-runtime')
# Client used to call Amazon Location (This is used in Lab 4)
location_client = boto3.client('geo-places')

CONTACTS_TABLE = os.environ.get('CONTACTS_TABLE', 'sca-analytics')
BEDROCK_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')


# [PLACEHOLDER_LAB4_FUNCTION] Lab 4: Add verify_address_step function here
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

# Area code to state mapping (common US area codes)
AREA_CODE_STATES = {
    '213': 'CA', '310': 'CA', '415': 'CA', '619': 'CA', '818': 'CA', '925': 'CA',
    '312': 'IL', '773': 'IL', '847': 'IL',
    '212': 'NY', '718': 'NY', '917': 'NY', '646': 'NY',
    '305': 'FL', '786': 'FL', '407': 'FL', '954': 'FL',
    '214': 'TX', '512': 'TX', '713': 'TX', '972': 'TX',
    '202': 'DC',
    '303': 'CO', '720': 'CO',
    '404': 'GA', '678': 'GA',
    '602': 'AZ', '480': 'AZ',
}


@durable_step
def verify_phone_area_code_step(step_ctx: StepContext, attrs: Dict[str, str]) -> Dict[str, Any]:
    """Check if phone area code matches stated state."""
    phone = attrs.get('phoneNumber', '')
    stated_state = (attrs.get('inTakeAgentState') or '').upper().strip()

    # Extract digits and get area code
    digits = ''.join(c for c in phone if c.isdigit())
    if len(digits) < 10:
        return {'verified': False, 'reason': 'Invalid phone number', 'stateMatch': False}

    area_code = digits[-10:-7]
    expected_state = AREA_CODE_STATES.get(area_code)

    return {
        'verified': expected_state is not None,
        'areaCode': area_code,
        'expectedState': expected_state,
        'stateMatch': expected_state == stated_state,
        'reason': f'Area code {area_code} maps to {expected_state}' if expected_state else f'Area code {area_code} not in lookup table',
    }

# [PLACEHOLDER_LAB5_FUNCTIONS] Lab 5: Add save_callback_id_step and update_review_decision_step functions here

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

    # [PLACEHOLDER_LAB3_ELIGIBILITY_STEP] Durable Step 1: Call check_eligibility_step
        # Configure retry strategy for durable steps
    retry_config = RetryStrategyConfig(
        max_attempts=3,              # Total attempts: 1 initial + 2 retries
        initial_delay=Duration.from_seconds(2),  # Wait 2s before first retry
        backoff_rate=2.0,            # Multiply delay by 2 each retry (2s → 4s → 8s → ...)
        max_delay=Duration.from_seconds(30),     # Cap the exponential backoff at 30s
    )
    step_config = StepConfig(retry_strategy=create_retry_strategy(retry_config))

    # Durable Step 1: Check eligibility (with retry)
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

    # [PLACEHOLDER_LAB4_STEP] Lab 4: Add verify_address durable step call here

    # [PLACEHOLDER_LAB3_FRAUD_STEP] Durable Step 2: Call assess_fraud_step
    # Durable Step 2: Assess fraud likelihood via Bedrock
    # Assess fraud likelihood via Bedrock (enhanced with verification results)
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

    # [PLACEHOLDER_LAB3_STORE_STEP] Durable Step 3: Call store_contact_record_step
    # Durable Step 3: Store contact record with eligibility + fraud assessment
    context.step(
        store_contact_record_with_address_step(contact_id, attrs, eligibility, address_verification, fraud_assessment),
        name=f'store_contact_{contact_id}',
        config=step_config
    )

    logger.info("Contact record stored", extra={"contactId": contact_id})

    # [PLACEHOLDER_LAB5_CALLBACK] Lab 5: Add supervisor callback for HIGH risk cases here

    # [PLACEHOLDER_LAB3_REPLACE_RETURN] Replace this return block after implementing Durable Step 3
    return {
        'eligible': eligibility['eligible'],
        'plans': eligibility['plans'],
        'reason': eligibility['reason'],
        'fraudRiskLevel': fraud_assessment.get('risk_level', 'UNKNOWN'),
    }