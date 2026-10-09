"""
StartChatContact Lambda - Initiates a chat session with Amazon Connect.

This Lambda is called by authenticated users from the CRM frontend.
It calls the Connect StartChatContact API (which requires IAM credentials)
and returns a participant token that the browser uses to connect via ChatJS.
"""

import json
import os
import uuid

import boto3
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.event_handler import APIGatewayRestResolver
from aws_lambda_powertools.logging import correlation_paths

logger = Logger()
tracer = Tracer()
metrics = Metrics()

app = APIGatewayRestResolver()
connect_client = boto3.client("connect")

CONNECT_INSTANCE_ID = os.environ["CONNECT_INSTANCE_ID"]
CONTACT_FLOW_ID = os.environ["CONTACT_FLOW_ID"]


@app.post("/chat/start")
@tracer.capture_method
def start_chat():
    """Start a new chat contact and return participant connection details."""
    body = app.current_event.json_body or {}

    display_name = body.get("displayName", "Customer")
    attributes = body.get("attributes", {})

    # Ensure attributes are all strings (Connect requirement)
    safe_attributes = {k: str(v) for k, v in attributes.items() if isinstance(k, str)}

    try:
        response = connect_client.start_chat_contact(
            InstanceId=CONNECT_INSTANCE_ID,
            ContactFlowId=CONTACT_FLOW_ID,
            ParticipantDetails={"DisplayName": display_name},
            SupportedMessagingContentTypes=["text/plain", "text/markdown"],
            Attributes=safe_attributes,
            ClientToken=str(uuid.uuid4()),
        )

        logger.info("Chat contact started", extra={
            "contact_id": response["ContactId"],
            "participant_id": response["ParticipantId"],
        })

        return {
            "contactId": response["ContactId"],
            "participantId": response["ParticipantId"],
            "participantToken": response["ParticipantToken"],
        }

    except connect_client.exceptions.InvalidParameterException as e:
        logger.error("Invalid parameters for StartChatContact", extra={"error": str(e)})
        return {"statusCode": 400, "body": json.dumps({"error": "Invalid request parameters"})}

    except Exception as e:
        logger.exception("Failed to start chat contact")
        raise


@logger.inject_lambda_context(correlation_id_path=correlation_paths.API_GATEWAY_REST)
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    return app.resolve(event, context)
