"""
Lab 4 Helpers: Pre-built functions for address and phone verification integration.

These helpers include self-contained fraud assessment and store logic
enriched with address and phone verification context.
"""

import json
import os
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict

import boto3
from aws_lambda_powertools import Logger
from aws_durable_execution_sdk_python import durable_step, StepContext

logger = Logger()
dynamodb = boto3.resource('dynamodb')
bedrock_runtime = boto3.client('bedrock-runtime')

CONTACTS_TABLE = os.environ.get('CONTACTS_TABLE', 'sca-analytics')
BEDROCK_MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')

# Area code to state mapping (common US area codes)
AREA_CODE_STATES = {
    '213': 'CA', '310': 'CA', '415': 'CA', '619': 'CA', '818': 'CA', '925': 'CA',
    '312': 'IL', '773': 'IL', '847': 'IL', '872': 'IL',
    '212': 'NY', '718': 'NY', '917': 'NY', '646': 'NY',
    '305': 'FL', '786': 'FL', '407': 'FL', '954': 'FL',
    '214': 'TX', '512': 'TX', '713': 'TX', '972': 'TX',
    '202': 'DC',
    '303': 'CO', '720': 'CO',
    '404': 'GA', '678': 'GA',
    '602': 'AZ', '480': 'AZ',
}


def extract_json_from_response(text: str) -> str:
    """Strip markdown code blocks from Bedrock response if present."""
    text = text.strip()
    if text.startswith('```'):
        lines = text.split('\n')
        lines = [l for l in lines if not l.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    return text


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


@durable_step
def assess_fraud_with_address_verification_step(
    step_ctx: StepContext, attrs: Dict[str, str], eligibility: Dict[str, Any],
    address_verification: Dict[str, Any], phone_verification: Dict[str, Any],
) -> Dict[str, Any]:
    """Fraud assessment enriched with address and phone verification context."""
    # Build verification context
    address_context = ""
    if address_verification.get('verified'):
        if address_verification.get('stateMatch'):
            address_context = f"Address Verification: VERIFIED - Address matches stated state ({address_verification.get('geocodedState')})"
        else:
            address_context = f"Address Verification: MISMATCH - Stated state {attrs.get('inTakeAgentState', 'N/A')} but address geocodes to {address_verification.get('geocodedState')}"
    else:
        address_context = f"Address Verification: FAILED - {address_verification.get('reason', 'Unknown')}"

    phone_context = ""
    if phone_verification.get('verified'):
        if phone_verification.get('stateMatch'):
            phone_context = f"Phone Verification: MATCH - Area code {phone_verification.get('areaCode')} matches stated state"
        else:
            phone_context = f"Phone Verification: MISMATCH - Area code {phone_verification.get('areaCode')} maps to {phone_verification.get('expectedState')}, not {attrs.get('inTakeAgentState', 'N/A')}"
    else:
        phone_context = f"Phone Verification: INCONCLUSIVE - {phone_verification.get('reason', 'Unknown')}"

    # Build enriched prompt with verification context
    enriched_attrs = dict(attrs)
    enriched_attrs['addressVerificationContext'] = address_context
    enriched_attrs['phoneVerificationContext'] = phone_context

    prompt = f"""Analyze the following health insurance enrollment call data for potential indicators of inaccuracy or fraud. Focus only on the caller-provided information for inconsistencies and red flags.

Caller-Provided Information:
- Name: {enriched_attrs.get('firstName', 'N/A')} {enriched_attrs.get('lastName', 'N/A')}
- State of residence: {enriched_attrs.get('inTakeAgentState') or enriched_attrs.get('state', 'N/A')}
- Residential address: {enriched_attrs.get('residentialAddress', 'N/A')}
- Phone number: {enriched_attrs.get('phoneNumber', 'N/A')}
- Date of birth: {enriched_attrs.get('dateOfBirth', 'N/A')}
- Medicare status: {enriched_attrs.get('medicareEligible', 'unknown')}
- Reason for call: {enriched_attrs.get('inTakeAgentReason') or enriched_attrs.get('reason', 'N/A')}
- {address_context}
- {phone_context}

Note: Medicare status can be "yes", "no", or "unknown". A value of "unknown" means the caller was unsure — this is completely normal and must NOT be flagged as suspicious.

Evaluate for these risk indicators:
1. Address does not match stated state of residence (e.g., address mentions a different state)
2. Address appears fictional, implausible, or uses unusual/nonsensical street names
3. Implausible or clearly fake personal information (placeholder names like "John Doe", "Jane Smith", "Test User")
4. Phone number area code inconsistent with stated state/address
5. Missing or refused critical information (no DOB, no address, no name)
6. Implausible date of birth (future date, impossibly old, or caller would be under 18)
7. Medicare status contradicts date of birth (e.g., claims Medicare eligible but DOB shows age under 65)

RISK CALIBRATION:
- LOW: No concerns or only trivial observations. All information is internally consistent.
- MEDIUM: At least one concrete concern such as a suspicious address, name that looks like a placeholder, or a single data inconsistency. If the address looks fictional or unusual, this is at minimum MEDIUM.
- HIGH: Multiple red flags or a single severe indicator (e.g., clearly fake identity, multiple data points contradicting each other).

Respond in JSON:
{{
    "risk_score": 0.0 to 1.0 (0=no risk, 1=highly suspicious),
    "risk_level": "LOW" | "MEDIUM" | "HIGH",
    "flags": ["list of specific concerns"],
    "summary": "brief explanation"
}}

Return ONLY the JSON object, with no additional text before or after it."""

    try:
        response = bedrock_runtime.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 500,
                'messages': [{'role': 'user', 'content': prompt}],
                'temperature': 0.1,
            }),
        )

        response_body = json.loads(response['body'].read())
        content = response_body['content'][0]['text']
        result = json.loads(extract_json_from_response(content))

        logger.info("Fraud assessment completed (with verification)", extra={
            "risk_level": result.get('risk_level'),
            "risk_score": result.get('risk_score'),
        })
        result['addressVerificationUsed'] = True
        result['phoneVerificationUsed'] = True
        return result

    except Exception as e:
        logger.error(f"Fraud assessment failed: {e}")
        return {
            'risk_score': 0.0,
            'risk_level': 'UNKNOWN',
            'flags': ['Assessment unavailable'],
            'summary': f'Could not complete assessment: {str(e)}',
            'addressVerificationUsed': True,
            'phoneVerificationUsed': True,
        }


@durable_step
def store_contact_record_with_address_step(
    step_ctx: StepContext, contact_id: str, attrs: Dict[str, str],
    eligibility: Dict[str, Any], address_verification: Dict[str, Any],
    fraud_assessment: Dict[str, Any],
) -> Dict[str, str]:
    """Store contact record with eligibility, address verification, and fraud assessment."""
    table = dynamodb.Table(CONTACTS_TABLE)
    now = datetime.utcnow().isoformat()

    item = {
        'PK': contact_id,
        'SK': 'CONTACT#DETAILS',
        'contactId': contact_id,
        'firstName': attrs.get('firstName', ''),
        'lastName': attrs.get('lastName', ''),
        'phoneNumber': attrs.get('phoneNumber', ''),
        'state': attrs.get('inTakeAgentState') or attrs.get('state', ''),
        'medicareEligible': attrs.get('medicareEligible', 'false'),
        'reason': attrs.get('inTakeAgentReason') or attrs.get('reason', ''),
        'dateOfBirth': attrs.get('dateOfBirth', ''),
        'residentialAddress': attrs.get('residentialAddress', ''),
        'eligibility': {
            'eligible': eligibility['eligible'],
            'plans': eligibility['plans'],
            'reason': eligibility['reason'],
            'age': eligibility['age'],
        },
        'fraudAssessment': {
            'riskScore': fraud_assessment.get('risk_score', 0.0),
            'riskLevel': fraud_assessment.get('risk_level', 'UNKNOWN'),
            'flags': fraud_assessment.get('flags', []),
            'summary': fraud_assessment.get('summary', ''),
        },
        'addressVerification': {
            'verified': address_verification.get('verified', False),
            'geocodedState': address_verification.get('geocodedState'),
            'stateMatch': address_verification.get('stateMatch', False),
            'confidence': str(address_verification.get('confidence', 0.0)),
            'formattedAddress': address_verification.get('formattedAddress', ''),
            'reason': address_verification.get('reason', ''),
        },
        'createdAt': now,
        'updatedAt': now,
        # Review status (used in Lab 5 for supervisor approval workflow)
        'reviewStatus': 'PENDING_REVIEW' if fraud_assessment.get('risk_level') == 'HIGH' else 'AUTO_APPROVED',

        'GSI1PK': 'CONTACTS',
        'GSI1SK': f'CREATED#{now}',
    }

    item = json.loads(json.dumps(item, default=str), parse_float=Decimal)
    table.put_item(Item=item)
    return {'status': 'stored', 'contactId': contact_id}
