"""
StartWebRTCContact Lambda - Initiates an in-app (browser) voice call with Amazon Connect.

This Lambda is called by authenticated users from the CRM frontend. It calls the
Connect StartWebRTCContact API (which requires IAM credentials) and returns the
Amazon Chime SDK connection data + participant token that the browser uses to join
the WebRTC audio session via amazon-chime-sdk-js.

The call runs the same contact flow as voice/chat, so the caller talks to the
self-service Amazon Connect AI agents (Lex / Q in Connect) directly from the browser.
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


@app.post("/call/start")
@tracer.capture_method
def start_call():
    """Start a new WebRTC (in-app voice) contact and return Chime connection details."""
    body = app.current_event.json_body or {}

    display_name = body.get("displayName", "Customer")
    attributes = body.get("attributes", {})

    # Ensure attributes are all strings (Connect requirement)
    safe_attributes = {k: str(v) for k, v in attributes.items() if isinstance(k, str)}

    try:
        response = connect_client.start_web_rtc_contact(
            InstanceId=CONNECT_INSTANCE_ID,
            ContactFlowId=CONTACT_FLOW_ID,
            ParticipantDetails={"DisplayName": display_name},
            Attributes=safe_attributes,
            ClientToken=str(uuid.uuid4()),
            # Audio-only: omit Video/ScreenShare capabilities entirely. The API enum
            # only supports "SEND" to enable a capability; there is no "DISABLED"
            # value, so leaving them out keeps the call audio-only.
            AllowedCapabilities={
                "Customer": {},
                "Agent": {},
            },
            SegmentAttributes={
                "connect:Subtype": {"ValueString": "connect:WebRTC"},
            },
        )

        logger.info("WebRTC contact started", extra={
            "contact_id": response["ContactId"],
            "participant_id": response["ParticipantId"],
        })

        # ConnectionData contains the Chime SDK Meeting + Attendee the browser needs.
        return {
            "contactId": response["ContactId"],
            "participantId": response["ParticipantId"],
            "participantToken": response["ParticipantToken"],
            "connectionData": response["ConnectionData"],
        }

    except connect_client.exceptions.InvalidParameterException as e:
        logger.error("Invalid parameters for StartWebRTCContact", extra={"error": str(e)})
        return {"statusCode": 400, "body": json.dumps({"error": "Invalid request parameters"})}

    except Exception:
        logger.exception("Failed to start WebRTC contact")
        raise


@logger.inject_lambda_context(correlation_id_path=correlation_paths.API_GATEWAY_REST)
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    return app.resolve(event, context)
