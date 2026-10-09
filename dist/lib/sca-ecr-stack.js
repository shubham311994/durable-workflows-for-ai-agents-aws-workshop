"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScaEcrStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
/**
 * ScaEcrStack - ECR repository for the SCA web application
 *
 * This stack contains:
 * - ECR repository for container images
 *
 * This stack is deployed first, before the web app stack, so that
 * we can build and push the Docker image before deploying ECS.
 *
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
class ScaEcrStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // ECR Repository for web application images
        this.ecrRepository = new ecr.Repository(this, 'WebAppRepository', {
            repositoryName: 'sca-web-app',
            removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
            emptyOnDelete: true, // Automatically delete images when repository is deleted
            imageScanOnPush: true, // Scan images for vulnerabilities
        });
        // ========================================
        // CloudFormation Outputs (NO EXPORTS)
        // ========================================
        new cdk.CfnOutput(this, 'EcrRepositoryUri', {
            value: this.ecrRepository.repositoryUri,
            description: 'ECR repository URI for web application images',
        });
        new cdk.CfnOutput(this, 'EcrRepositoryName', {
            value: this.ecrRepository.repositoryName,
            description: 'ECR repository name',
        });
        new cdk.CfnOutput(this, 'BuildAndPushCommand', {
            value: `./scripts/deploy-container.sh`,
            description: 'Command to build and push Docker image to ECR',
        });
    }
}
exports.ScaEcrStack = ScaEcrStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NhLWVjci1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2luZnJhc3RydWN0dXJlL2xpYi9zY2EtZWNyLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLGlEQUFtQztBQUNuQyx5REFBMkM7QUFHM0M7Ozs7Ozs7Ozs7O0dBV0c7QUFDSCxNQUFhLFdBQVksU0FBUSxHQUFHLENBQUMsS0FBSztJQUd4QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDRDQUE0QztRQUM1QyxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDaEUsY0FBYyxFQUFFLGFBQWE7WUFDN0IsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTyxFQUFFLGtCQUFrQjtZQUM1RCxhQUFhLEVBQUUsSUFBSSxFQUFFLHlEQUF5RDtZQUM5RSxlQUFlLEVBQUUsSUFBSSxFQUFFLGtDQUFrQztTQUMxRCxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0Msc0NBQXNDO1FBQ3RDLDJDQUEyQztRQUUzQyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO1lBQzFDLEtBQUssRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLGFBQWE7WUFDdkMsV0FBVyxFQUFFLCtDQUErQztTQUM3RCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQzNDLEtBQUssRUFBRSxJQUFJLENBQUMsYUFBYSxDQUFDLGNBQWM7WUFDeEMsV0FBVyxFQUFFLHFCQUFxQjtTQUNuQyxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQzdDLEtBQUssRUFBRSwrQkFBK0I7WUFDdEMsV0FBVyxFQUFFLCtDQUErQztTQUM3RCxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFqQ0Qsa0NBaUNDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuXG4vKipcbiAqIFNjYUVjclN0YWNrIC0gRUNSIHJlcG9zaXRvcnkgZm9yIHRoZSBTQ0Egd2ViIGFwcGxpY2F0aW9uXG4gKiBcbiAqIFRoaXMgc3RhY2sgY29udGFpbnM6XG4gKiAtIEVDUiByZXBvc2l0b3J5IGZvciBjb250YWluZXIgaW1hZ2VzXG4gKiBcbiAqIFRoaXMgc3RhY2sgaXMgZGVwbG95ZWQgZmlyc3QsIGJlZm9yZSB0aGUgd2ViIGFwcCBzdGFjaywgc28gdGhhdFxuICogd2UgY2FuIGJ1aWxkIGFuZCBwdXNoIHRoZSBEb2NrZXIgaW1hZ2UgYmVmb3JlIGRlcGxveWluZyBFQ1MuXG4gKiBcbiAqIFJlc291cmNlcyBhcmUgZXhwb3NlZCB2aWEgcHVibGljIHJlYWRvbmx5IHByb3BlcnRpZXMgZm9yIHVzZSBieSBvdGhlciBzdGFja3MuXG4gKiBOTyBDbG91ZEZvcm1hdGlvbiBleHBvcnRzIGFyZSB1c2VkIHRvIGF2b2lkIGNyb3NzLXN0YWNrIGRlcGVuZGVuY2llcy5cbiAqL1xuZXhwb3J0IGNsYXNzIFNjYUVjclN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGVjclJlcG9zaXRvcnk6IGVjci5SZXBvc2l0b3J5O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIEVDUiBSZXBvc2l0b3J5IGZvciB3ZWIgYXBwbGljYXRpb24gaW1hZ2VzXG4gICAgdGhpcy5lY3JSZXBvc2l0b3J5ID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsICdXZWJBcHBSZXBvc2l0b3J5Jywge1xuICAgICAgcmVwb3NpdG9yeU5hbWU6ICdzY2Etd2ViLWFwcCcsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLCAvLyBGb3IgZGV2ZWxvcG1lbnRcbiAgICAgIGVtcHR5T25EZWxldGU6IHRydWUsIC8vIEF1dG9tYXRpY2FsbHkgZGVsZXRlIGltYWdlcyB3aGVuIHJlcG9zaXRvcnkgaXMgZGVsZXRlZFxuICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLCAvLyBTY2FuIGltYWdlcyBmb3IgdnVsbmVyYWJpbGl0aWVzXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ2xvdWRGb3JtYXRpb24gT3V0cHV0cyAoTk8gRVhQT1JUUylcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0VjclJlcG9zaXRvcnlVcmknLCB7XG4gICAgICB2YWx1ZTogdGhpcy5lY3JSZXBvc2l0b3J5LnJlcG9zaXRvcnlVcmksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUiByZXBvc2l0b3J5IFVSSSBmb3Igd2ViIGFwcGxpY2F0aW9uIGltYWdlcycsXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRWNyUmVwb3NpdG9yeU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5lY3JSZXBvc2l0b3J5LnJlcG9zaXRvcnlOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1IgcmVwb3NpdG9yeSBuYW1lJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdCdWlsZEFuZFB1c2hDb21tYW5kJywge1xuICAgICAgdmFsdWU6IGAuL3NjcmlwdHMvZGVwbG95LWNvbnRhaW5lci5zaGAsXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvbW1hbmQgdG8gYnVpbGQgYW5kIHB1c2ggRG9ja2VyIGltYWdlIHRvIEVDUicsXG4gICAgfSk7XG4gIH1cbn1cbiJdfQ==