#!/bin/bash
# Invoke the eligibility-checker Lambda with a sample caller payload
# Usage: ./scripts/check-eligibility.sh [contact-id]
#
# Simulates the Connect contact flow invoking the eligibility-checker
# with caller attributes collected by the InTakeAgent.

set -euo pipefail

# Find the eligibility-checker Lambda function name
FUNCTION_NAME=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName, 'ScaAiStack') && contains(FunctionName, 'EligibilityChecker')].FunctionName" \
  --output text 2>/dev/null)

if [ -z "$FUNCTION_NAME" ] || [ "$FUNCTION_NAME" = "None" ]; then
  echo "Error: Could not find eligibility-checker Lambda function."
  echo "Make sure the stack is deployed: cdk deploy ScaBackendStack"
  exit 1
fi

echo "Using Lambda function: $FUNCTION_NAME"

# Use provided contact ID or generate one
CONTACT_ID="${1:-contact-$(date +%s)-$(( RANDOM % 1000 ))}"

echo "Contact ID: $CONTACT_ID"
echo ""

# Sample payload matching the InTakeAgent conversation
PAYLOAD=$(cat <<EOF
{
  "Details": {
    "ContactData": {
      "ContactId": "$CONTACT_ID",
      "Attributes": {
        "firstName": "Jane",
        "lastName": "Doe",
        "dateOfBirth": "03/15/1958",
        "inTakeAgentState": "CA",
        "residentialAddress": "123 Main Street, Los Angeles, CA 90001",
        "phoneNumber": "(213) 555-0100",
        "medicareEligible": "yes",
        "inTakeAgentReason": "Looking into Medicare Advantage plans"
      }
    }
  }
}
EOF
)

echo "Invoking eligibility-checker with sample caller data..."
echo "  Name: Jane Doe"
echo "  DOB: 03/15/1958"
echo "  State: CA"
echo "  Medicare: yes"
echo "  Reason: Looking into Medicare Advantage plans"
echo ""

TMPFILE=$(mktemp)
echo "$PAYLOAD" > "$TMPFILE"

RESPONSE=$(aws lambda invoke \
  --function-name "$FUNCTION_NAME:\$LATEST" \
  --payload "fileb://$TMPFILE" \
  --cli-binary-format raw-in-base64-out \
  /tmp/lambda-response.json 2>&1)

echo "Response:"
cat /tmp/lambda-response.json | python3 -m json.tool 2>/dev/null || cat /tmp/lambda-response.json
rm -f "$TMPFILE" /tmp/lambda-response.json
