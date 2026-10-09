#!/bin/bash

# Script to reset a Cognito user's password with a random temporary password
# Use this if you did not receive the temporary password email from Cognito.
# Usage: ./scripts/reset-user-password.sh <email>

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Cognito Password Reset ===${NC}"
echo ""

# Check if email is provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Email address is required${NC}"
  echo "Usage: ./scripts/reset-user-password.sh <email>"
  exit 1
fi

EMAIL="$1"

# Validate email format
if ! echo "$EMAIL" | grep -qE '^[^@]+@[^@]+\.[^@]+$'; then
  echo -e "${RED}Error: Invalid email format${NC}"
  exit 1
fi

# Get the stack name (default to ScaBackendStack)
STACK_NAME="${STACK_NAME:-ScaBackendStack}"

# Get User Pool ID from CloudFormation outputs
echo -e "${YELLOW}Fetching User Pool ID from CloudFormation...${NC}"
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text)

if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "None" ]; then
  echo -e "${RED}Error: Could not find User Pool ID in stack outputs${NC}"
  echo "Make sure the stack '$STACK_NAME' is deployed"
  exit 1
fi

echo -e "${GREEN}User Pool ID: $USER_POOL_ID${NC}"

# Check if the user already exists, if not create it
echo -e "${YELLOW}Checking if user exists...${NC}"
if ! aws cognito-idp admin-get-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" > /dev/null 2>&1; then
  echo -e "${YELLOW}User does not exist. Creating user...${NC}"
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$EMAIL" \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
    --message-action SUPPRESS

  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" \
    --username "$EMAIL" \
    --group-name "Analysts"

  echo -e "${GREEN}✓ User created and added to Analysts group${NC}"
fi

# Generate a random temporary password that meets Cognito requirements:
# - At least 8 characters
# - Uppercase, lowercase, digit, special character
RANDOM_PART=$(openssl rand -base64 12 | tr -d '/+=' | head -c 10)
TEMP_PASSWORD="${RANDOM_PART}A1!"

# Set the temporary password on the user
echo -e "${YELLOW}Setting temporary password for $EMAIL...${NC}"
aws cognito-idp admin-set-user-password \
  --user-pool-id "$USER_POOL_ID" \
  --username "$EMAIL" \
  --password "$TEMP_PASSWORD" \
  --no-permanent

echo ""
echo -e "${GREEN}✓ Temporary password set successfully!${NC}"
echo ""
echo -e "${GREEN}=====================================${NC}"
echo -e "${GREEN}  Your temporary login credentials${NC}"
echo -e "${GREEN}=====================================${NC}"
echo -e "  Email:    ${YELLOW}$EMAIL${NC}"
echo -e "  Password: ${YELLOW}$TEMP_PASSWORD${NC}"
echo -e "${GREEN}=====================================${NC}"
echo ""
echo -e "${YELLOW}You will be prompted to set a new password on first sign-in.${NC}"
