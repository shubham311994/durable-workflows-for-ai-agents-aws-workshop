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
from aws_durable_execution_sdk_python.config import StepConfig, Duration
from aws_durable_execution_sdk_python.retries import RetryStrategyConfig, create_retry_strategy
from lab3_helpers import check_eligibility_step, assess_fraud_step, store_contact_record_step

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

    # Durable Step 1: Check eligibility
    eligibility = context.step(
        check_eligibility_step(attrs),
        name=f'check_eligibility_{contact_id}'
    )

    logger.info("Eligibility result", extra={
        "contactId": contact_id,
        "eligible": eligibility['eligible'],
        "plans": eligibility['plans'],
    })

    # [PLACEHOLDER_LAB4_STEP] Lab 4: Add verify_address durable step call here

    # Durable Step 2: Assess fraud likelihood via Bedrock
    fraud_assessment = context.step(
        assess_fraud_step(attrs, eligibility),
        name=f'assess_fraud_{contact_id}'
    )

    logger.info("Fraud assessment result", extra={
        "contactId": contact_id,
        "riskLevel": fraud_assessment.get('risk_level'),
        "riskScore": fraud_assessment.get('risk_score'),
    })

    # Durable Step 3: Store contact record with eligibility + fraud assessment
    context.step(
        store_contact_record_step(contact_id, attrs, eligibility, fraud_assessment),
        name=f'store_contact_{contact_id}'
    )

    logger.info("Contact record stored", extra={"contactId": contact_id})

    # [PLACEHOLDER_LAB5_CALLBACK] Lab 5: Add supervisor callback for HIGH risk cases here

    metrics.add_metric(name="EligibilityChecked", unit=MetricUnit.Count, value=1)
    if eligibility['eligible']:
        metrics.add_metric(name="EligibleContacts", unit=MetricUnit.Count, value=1)
    if fraud_assessment.get('risk_level') == 'HIGH':
        metrics.add_metric(name="HighRiskContacts", unit=MetricUnit.Count, value=1)

    return {
        'eligible': eligibility['eligible'],
        'plans': eligibility['plans'],
        'reason': eligibility['reason'],
        'fraudRiskLevel': fraud_assessment.get('risk_level', 'UNKNOWN'),
    }
