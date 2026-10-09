#!/bin/bash
# Display Amazon Connect phone number claim UI and admin login credentials
# Usage: ./scripts/connect-claim-number.sh [region]
#
# Opens the Connect console page where you can claim a phone number
# in your preferred country, and displays the admin credentials to log in.

REGION="${1:-}"
REGION_FLAG=""
if [ -n "$REGION" ]; then
  REGION_FLAG="--region $REGION"
fi

# Retrieve Connect instance alias (used to build URLs)
INSTANCE_ALIAS=$(aws cloudformation describe-stacks \
  --stack-name ScaConnectStack \
  $REGION_FLAG \
  --query "Stacks[0].Outputs[?OutputKey=='ConnectInstanceId'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$INSTANCE_ALIAS" ] || [ "$INSTANCE_ALIAS" = "None" ]; then
  echo "Error: Could not retrieve Connect instance from ScaConnectStack."
  echo "Make sure the stack is deployed: cdk deploy ScaConnectStack -c enableConnect=true"
  exit 1
fi

# Get the login URL from stack outputs
LOGIN_URL=$(aws cloudformation describe-stacks \
  --stack-name ScaConnectStack \
  $REGION_FLAG \
  --query "Stacks[0].Outputs[?OutputKey=='ConnectLoginUrl'].OutputValue" \
  --output text 2>/dev/null)

# Get the credentials command and extract the secret ARN from it
CREDS_COMMAND=$(aws cloudformation describe-stacks \
  --stack-name ScaConnectStack \
  $REGION_FLAG \
  --query "Stacks[0].Outputs[?OutputKey=='GetCredentialsCommand'].OutputValue" \
  --output text 2>/dev/null)

# Execute the credentials command
PASSWORD=$(eval "$CREDS_COMMAND")

# Build the claim number URL from the login URL base
CLAIM_URL=$(echo "$LOGIN_URL" | sed 's|/connect/login|/numbers#/claim|')

echo "============================================================"
echo " Amazon Connect - Claim a Phone Number"
echo "============================================================"
echo ""
echo "Login to Amazon Connect console using the below URL, Username and Password provided"
echo ""
echo "   URL:      $CLAIM_URL"
echo "   Username: admin"
echo "   Password: $PASSWORD"
echo ""
echo "============================================================"