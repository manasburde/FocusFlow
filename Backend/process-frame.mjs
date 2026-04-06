import { RekognitionClient, DetectFacesCommand } from "@aws-sdk/client-rekognition";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, QueryCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Initialize AWS Clients inside Lambda environment automatically inheriting execution role
// Note: If deployed via AWS console, region is automatically set.
const rekognition = new RekognitionClient({ region: process.env.AWS_REGION });
const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

export const handler = async (event) => {
    try {
        console.log("Event received:", event);
        
        // Handle CORS preflight in Lambda Proxy integration (supports both REST API and HTTP API formats)
        const httpMethod = event.httpMethod || (event.requestContext && event.requestContext.http && event.requestContext.http.method);
        if (httpMethod === 'OPTIONS') {
             return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
                    "Access-Control-Allow-Headers": "*"
                },
                body: ""
            };
        }

        // The request specifies either returning history OR processing a frame
        const body = JSON.parse(event.body || '{}');
        const userId = body.userId;
        const action = body.action || 'process'; // 'process' or 'history'
        
        if (!userId) {
            return {
                statusCode: 400,
                headers: { "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ error: "Missing userId" })
            };
        }

        if (action === 'history') {
            return await fetchHistory(userId);
        }

        const base64Image = body.image;
        if (!base64Image) {
            return {
                statusCode: 400,
                headers: { "Access-Control-Allow-Origin": "*" },
                body: JSON.stringify({ error: "Missing image data" })
            };
        }

        // 1. Process base64 Image string
        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
        const imageBuffer = Buffer.from(base64Data, "base64");

        // 2. Call AWS Rekognition
        const detectCommand = new DetectFacesCommand({
            Image: { Bytes: imageBuffer },
            Attributes: ["ALL"]
        });
        
        const rekognitionResult = await rekognition.send(detectCommand);
        
        let focusScore = 0;
        let primaryEmotion = "NEUTRAL";
        
        // 3. Analyze output and calculate focus score
        if (rekognitionResult.FaceDetails && rekognitionResult.FaceDetails.length > 0) {
            const face = rekognitionResult.FaceDetails[0];
            
            // Base score for presence
            focusScore = 30; 
            
            // Check Eyes Open
            if (face.EyesOpen && face.EyesOpen.Value && face.EyesOpen.Confidence > 80) {
                focusScore += 25; 
            } else if (face.EyesOpen && !face.EyesOpen.Value && face.EyesOpen.Confidence > 80) {
                focusScore -= 30; // Eyes closed indicates extreme lack of focus/sleep
            }

            // Check if eyes are covered by sunglasses (which makes gaze tracking impossible)
            if (face.Sunglasses && face.Sunglasses.Value && face.Sunglasses.Confidence > 80) {
                focusScore -= 10;
            }
            
            // Check Head Pose (Looking at screen)
            // Roll, Pitch, Yaw values close to 0 mean looking straight
            const yaw = Math.abs(face.Pose.Yaw || 0);
            const pitch = Math.abs(face.Pose.Pitch || 0);
            
            if (yaw < 15 && pitch < 15) {
                focusScore += 25; // Looking straight at the screen
            } else if (yaw > 35 || pitch > 35) {
                focusScore -= 20; // Looking completely away from screen
            } else {
                focusScore += 10; // Looking slightly away is okay
            }
            
            // Emotions Analysis
            // Emotions returned are sorted by Confidence
            if (face.Emotions && face.Emotions.length > 0) {
                const emotionalState = face.Emotions[0];
                primaryEmotion = emotionalState.Type;
                
                // Only weigh emotion heavily if we're fairly confident
                if (emotionalState.Confidence > 60) {
                    switch(primaryEmotion) {
                        case "CALM":
                            focusScore += 20;
                            break;
                        case "HAPPY":
                            focusScore += 15;
                            break;
                        case "CONFUSED":
                            focusScore -= 10; // penalty for confusion (maybe distracted or stuck)
                            break;
                        case "SAD":
                        case "ANGRY":
                        case "FEAR":
                        case "SURPRISED":
                        case "DISGUSTED":
                            focusScore -= 15; // Negative emotions severely disrupt flow
                            break;
                        default: // NEUTRAL
                            focusScore += 10;
                    }
                }
            }

            // Check Mouth Open (potentially yawning or talking to someone else)
            if (face.MouthOpen && face.MouthOpen.Value && face.MouthOpen.Confidence > 80) {
                if (primaryEmotion !== "HAPPY" && primaryEmotion !== "SURPRISED") {
                    focusScore -= 15; // Yawning or talking when not happy/surprised
                }
            }

        } else {
            // No face detected
            focusScore = 0;
            primaryEmotion = "NOT_DETECTED";
        }
        
        // Clamp score between 0 and 100
        focusScore = Math.max(0, Math.min(100, Math.floor(focusScore)));

        // 4. Save to DynamoDB
        const timestamp = new Date().toISOString();
        const putCommand = new PutCommand({
            TableName: "FocusFlowSessions",
            Item: {
                userId: userId,
                timestamp: timestamp,
                score: focusScore,
                emotion: primaryEmotion
            }
        });
        
        await docClient.send(putCommand);

        // 5. Return success
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
            },
            body: JSON.stringify({ 
                success: true, 
                score: focusScore, 
                emotion: primaryEmotion,
                timestamp 
            })
        };

    } catch (error) {
        console.error("Error Processing Request:", error);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: error.message || "Internal Server Error" })
        };
    }
};

async function fetchHistory(userId) {
    try {
        // Query last 50 session traces for the user (we assume sorting by timestamp)
        const queryCommand = new QueryCommand({
            TableName: "FocusFlowSessions",
            KeyConditionExpression: "userId = :uid",
            ExpressionAttributeValues: {
                ":uid": userId
            },
            ScanIndexForward: false, // newest first
            Limit: 50
        });
        
        const results = await docClient.send(queryCommand);
        
        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
            },
            body: JSON.stringify({ data: results.Items })
        };
    } catch(err) {
        console.error("Error fetching history:", err);
        return {
            statusCode: 500,
            headers: { "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: "Could not fetch history" })
        };
    }
}
