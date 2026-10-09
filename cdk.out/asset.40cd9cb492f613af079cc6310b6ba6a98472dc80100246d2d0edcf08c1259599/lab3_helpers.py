"""
Lab 3 Helpers: Pre-built functions for the eligibility checker durable steps.

These functions implement:
- Eligibility determination based on age, state, and Medicare status
- AI-powered fraud assessment using Amazon Bedrock
- Contact record storage in DynamoDB
"""

import json
import os
from datetime import datetime, date
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

# States where Acme Insurance offers Medicare Advantage plans (sample)
MEDICARE_ADVANTAGE_STATES = {
    'IL', 'TX', 'FL', 'CA', 'NY', 'PA', 'OH', 'GA', 'NC', 'MI',
    'NJ', 'VA', 'WA', 'AZ', 'MA', 'TN', 'IN', 'MO', 'MD', 'WI',
    'CO', 'MN', 'SC', 'AL', 'LA', 'KY', 'OR', 'OK', 'CT', 'IA',
}

# States where Acme Insurance offers ACA Marketplace plans (sample)
ACA_MARKETPLACE_STATES = {
    'IL', 'TX', 'FL', 'CA', 'NY', 'PA', 'OH', 'GA', 'NC', 'MI',
    'NJ', 'VA', 'WA', 'AZ', 'MA', 'TN', 'IN', 'MO', 'MD', 'WI',
    'CO', 'MN', 'SC', 'AL', 'LA', 'KY', 'OR', 'OK', 'CT', 'IA',
    'NV', 'UT', 'AR', 'MS', 'KS', 'NE', 'NM', 'WV', 'ID', 'HI',
    'NH', 'ME', 'MT', 'RI', 'DE', 'SD', 'ND', 'AK', 'VT', 'WY', 'DC',
}

MINIMUM_AGE = 18


def calculate_age(dob_str: str) -> int:
    """Calculate age from date of birth string (MM/DD/YYYY or similar)."""
    for fmt in ('%m/%d/%Y', '%Y-%m-%d', '%m-%d-%Y', '%B %d, %Y'):
        try:
            dob = datetime.strptime(dob_str, fmt).date()
            today = date.today()
            return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
        except ValueError:
            continue
    return -1


def extract_json_from_response(text: str) -> str:
    """Strip markdown code blocks from Bedrock response if present."""
    text = text.strip()
    if text.startswith('```'):
        lines = text.split('\n')
        lines = [l for l in lines if not l.strip().startswith('```')]
        text = '\n'.join(lines).strip()
    return text


@durable_step
def check_eligibility_step(step_ctx: StepContext, attrs: Dict[str, str]) -> Dict[str, Any]:
    """Durable step: Determine plan eligibility."""
    # --- RETRY TEST ONLY: Simulates a transient failure to demonstrate the retry strategy.
    # When firstName is "FailUntil:<epoch>", the step raises an error until that timestamp,
    # then succeeds on the next retry. This is NOT production logic.
    import time
    first_name = attrs.get('firstName', '')
    if first_name.startswith('FailUntil:'):
        fail_until = int(first_name.split(':')[1])
        if time.time() < fail_until:
            raise RuntimeError(f"Simulated transient failure (retries until epoch {fail_until})")
    # --- END RETRY TEST

    state = (attrs.get('inTakeAgentState') or attrs.get('state') or '').upper().strip()
    medicare_status = (attrs.get('medicareEligible') or 'unknown').lower().strip()
    medicare_eligible = medicare_status == 'yes'
    dob_str = attrs.get('dateOfBirth', '')

    age = calculate_age(dob_str) if dob_str else -1
    plans = []
    reasons = []

    if 0 <= age < MINIMUM_AGE:
        return {
            'eligible': False, 'plans': [], 'age': age,
            'reason': f'Caller is under {MINIMUM_AGE} years of age',
        }

    if medicare_eligible or age >= 65:
        if state in MEDICARE_ADVANTAGE_STATES:
            plans.extend(['Medicare Advantage', 'Medicare Supplement'])
            reasons.append(f'Medicare eligible in {state}')
        else:
            reasons.append(f'Medicare eligible but {state} not in service area')

    if not medicare_eligible and age < 65:
        if state in ACA_MARKETPLACE_STATES:
            plans.extend(['ACA Marketplace', 'Individual & Family'])
            reasons.append(f'ACA eligible in {state}')
        else:
            reasons.append(f'{state} not in service area for ACA plans')

    return {
        'eligible': len(plans) > 0,
        'plans': plans,
        'reason': '; '.join(reasons) if reasons else 'No matching plans',
        'age': age,
    }


@durable_step
def assess_fraud_step(step_ctx: StepContext, attrs: Dict[str, str], eligibility: Dict[str, Any]) -> Dict[str, Any]:
    """Durable step: Use Bedrock to assess likelihood of inaccurate or fraudulent call."""
    prompt = f"""Analyze the following health insurance enrollment call data for potential indicators of inaccuracy or fraud. Focus only on the caller-provided information for inconsistencies and red flags.

Caller-Provided Information:
- Name: {attrs.get('firstName', 'N/A')} {attrs.get('lastName', 'N/A')}
- State of residence: {attrs.get('inTakeAgentState') or attrs.get('state', 'N/A')}
- Residential address: {attrs.get('residentialAddress', 'N/A')}
- Phone number: {attrs.get('phoneNumber', 'N/A')}
- Date of birth: {attrs.get('dateOfBirth', 'N/A')}
- Medicare status: {attrs.get('medicareEligible', 'unknown')}
- Reason for call: {attrs.get('inTakeAgentReason') or attrs.get('reason', 'N/A')}

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

        logger.info("Fraud assessment completed", extra={
            "risk_level": result.get('risk_level'),
            "risk_score": result.get('risk_score'),
        })
        return result

    except Exception as e:
        logger.error(f"Fraud assessment failed: {e}")
        return {
            'risk_score': 0.0,
            'risk_level': 'UNKNOWN',
            'flags': ['Assessment unavailable'],
            'summary': f'Could not complete assessment: {str(e)}',
        }


@durable_step
def store_contact_record_step(
    step_ctx: StepContext, contact_id: str, attrs: Dict[str, str],
    eligibility: Dict[str, Any], fraud_assessment: Dict[str, Any],
) -> Dict[str, str]:
    """Durable step: Store contact record with eligibility and fraud assessment."""
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
