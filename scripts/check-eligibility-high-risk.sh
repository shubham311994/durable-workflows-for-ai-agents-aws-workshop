#!/bin/bash
# Invoke the eligibility-checker Lambda with HIGH-risk caller data
# Usage: ./scripts/check-eligibility-high-risk.sh [contact-id]
#
# Uses deliberately suspicious data to trigger a HIGH fraud risk assessment:
# - Fake-sounding name ("Test User")
# - Address in a different state than claimed
# - Phone area code mismatch

set -euo pipefail

# Find the eligibility-checker Lambda function name
FUNCTION_NAME=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName, 'ScaAiStack') && contains(FunctionName, 'EligibilityChecker')].FunctionName" \
  --output text 2>/dev/null)

if [ -z "$FUNCTION_NAME" ] || [ "$FUNCTION_NAME" = "None" ]; then
  echo "Error: Could not find eligibility-checker Lambda function."
  echo "Make sure the stack is deployed: cdk deploy ScaAiStack"
  exit 1
fi

echo "Using Lambda function: $FUNCTION_NAME"

# Use provided contact ID or generate one
CONTACT_ID="${1:-contact-$(date +%s)-$(( RANDOM % 1000 ))}"

echo "Contact ID: $CONTACT_ID"
echo ""

# HIGH-risk payload: multiple fraud indicators
PAYLOAD=$(cat <<EOF
{
  "Details": {
    "ContactData": {
      "ContactId": "$CONTACT_ID",
      "Attributes": {
        "firstName": "Test",
        "lastName": "User",
        "dateOfBirth": "01/01/1990",
        "inTakeAgentState": "FL",
        "residentialAddress": "999 Fake Boulevard, Phoenix, AZ 85001",
        "phoneNumber": "(312) 555-0199",
        "medicareEligible": "yes",
        "inTakeAgentReason": "Want to sign up for all available plans immediately"
      }
    }
  }
}
EOF
)

echo "Invoking eligibility-checker with HIGH-RISK caller data..."
echo "  Name: Test User (placeholder name)"
echo "  DOB: 01/01/1990 (age ~35, claims Medicare)"
echo "  State: FL (but address is in AZ)"
echo "  Address: 999 Fake Boulevard, Phoenix, AZ 85001"
echo "  Phone: (312) 555-0199 (Chicago area code)"
echo "  Medicare: yes (contradicts age)"
echo "  Reason: Want to sign up for all available plans immediately"
echo ""

TMPFILE=$(mktemp)
echo "$PAYLOAD" > "$TMPFILE"

RESPONSE=$(aws lambda invoke \
  --function-name "$FUNCTION_NAME:\$LATEST" \
  --invocation-type Event \
  --payload "fileb://$TMPFILE" \
  --cli-binary-format raw-in-base64-out \
  /tmp/lambda-response.json 2>&1)

echo "Lambda invoked asynchronously (Status 202 = success)"
echo "$RESPONSE"
echo ""
echo "Waiting 15 seconds for the Lambda to process and suspend at callback..."
sleep 15
echo "Done. Check the CRM or DynamoDB for contact: $CONTACT_ID"
rm -f "$TMPFILE" /tmp/lambda-response.json
