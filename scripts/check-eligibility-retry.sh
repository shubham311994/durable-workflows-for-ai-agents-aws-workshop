#!/bin/bash
# Test the retry strategy by invoking the eligibility-checker with a simulated transient failure.
# The step will fail for 10 seconds, then succeed on a subsequent retry.
# Usage: ./scripts/check-eligibility-retry.sh [contact-id]

set -euo pipefail

# Find the eligibility-checker Lambda function name
FUNCTION_NAME=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName, 'ScaAiStack') && contains(FunctionName, 'EligibilityChecker')].FunctionName" \
  --output text 2>/dev/null)

if [ -z "$FUNCTION_NAME" ] || [ "$FUNCTION_NAME" = "None" ]; then
  echo "Error: Could not find eligibility-checker Lambda function."
  echo "Make sure the stack is deployed: cdk deploy ScaAiStack -c enableConnect=true"
  exit 1
fi

echo "Using Lambda function: $FUNCTION_NAME"

# Use provided contact ID or generate one
CONTACT_ID="${1:-contact-retry-$(date +%s)-$(( RANDOM % 1000 ))}"

# Fail for 10 seconds — with backoff (2s → 4s → 8s), the step succeeds on the 2nd or 3rd retry
FAIL_UNTIL=$(($(date +%s) + 5))

echo "Contact ID: $CONTACT_ID"
echo "Step will fail until epoch: $FAIL_UNTIL ($(date -d @$FAIL_UNTIL 2>/dev/null || date -r $FAIL_UNTIL 2>/dev/null || echo 'in ~5 seconds'))"
echo ""

PAYLOAD=$(cat <<EOF
{
  "Details": {
    "ContactData": {
      "ContactId": "$CONTACT_ID",
      "Attributes": {
        "firstName": "FailUntil:$FAIL_UNTIL",
        "lastName": "RetryTest",
        "dateOfBirth": "03/15/1958",
        "inTakeAgentState": "CA",
        "residentialAddress": "123 Main Street, Los Angeles, CA 90001",
        "phoneNumber": "(213) 555-0100",
        "medicareEligible": "yes",
        "inTakeAgentReason": "Testing retry strategy"
      }
    }
  }
}
EOF
)

echo "Invoking eligibility-checker with simulated transient failure..."
echo "  The eligibility step will FAIL for ~10 seconds, then SUCCEED on retry."
echo "  Check CloudWatch Logs to see the retry behavior."
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
