// TODO: Implement data validation for incoming webhooks
// TODO: Send an email everytime a webhook fails and deactivate the webhook after 3 times

import { MongoClient } from "mongodb";
import { ulid } from "ulid";
import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

// Variables
let dbClient;
const app = express();
const port = process.env.PORT || 3000;
const secretKey = process.env.SECRET_KEY;
const apiSecret = process.env.API_SECRET;

app.use(express.json());

// Utility functions
// Function to derive a key from a password and salt
function deriveKey(apiSecret, salt) {
  return crypto.scryptSync(apiSecret, Buffer.from(salt, 'base64'), 32);
}

// Function to decrypt the API key
function decryptApiKey(encryptedData, key) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encryptedData.nonce, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encryptedData.tag, 'base64'));
  let decrypted = decipher.update(encryptedData.ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function getApiKey(apiKey) {
  const key = deriveKey(apiSecret, apiKey.salt);
  return decryptApiKey(apiKey, key);
}

async function connectToDatabase(op = "open") {
  const url = process.env.DATABASE_URL;
  const dbName = "cw-webhook-listener";

  if (op === "open") {
    if (!dbClient) {
      dbClient = new MongoClient(url);
    }

    try {
      if (!dbClient) {
        await dbClient.connect();
        console.log("Connected successfully to MongoDB");
      }
      const db = dbClient.db(dbName);
      return db;
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  } else if (op === "close") {
    if (dbClient) {
      try {
        await dbClient.close();
        dbClient = null;
      } catch (error) {
        console.error("Error closing MongoDB connection:", error);
        throw error;
      }
    }
  }
}

async function takeApplicationBackup(serverId, appId, apiKey, email) {
  const url = `https://api.cloudways.com/api/v1/app/manage/takeBackup?server_id=${serverId}&app_id=${appId}`;
  try {
    apiKey = getApiKey(apiKey);
    const accessTokenResponse = await generateAccessToken(email, apiKey);
    const accessToken = await accessTokenResponse.json();
    const takeBackupResponse = await fetch(url, {
      method: "POST",
      headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken.access_token}`, // Use the actual token value
      },
    });

    if (!takeBackupResponse.ok) {
      throw new Error(`HTTP error! status: ${takeBackupResponse.status}`);
    }

    const backupDetails = await takeBackupResponse.json();
    const backupStatusUrl = `https://api.cloudways.com/api/v1/operation/${backupDetails.operation_id}`;
    let backupStatus = 0;
    let backupStatusPoll;
    let backupStatusData;

    while (backupStatus === 0) {
      backupStatusPoll = await fetch(backupStatusUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken.access_token}`,
        },
      });

      if (!backupStatusPoll.ok) {
        throw new Error(`HTTP error! status: ${backupStatusPoll.status}`);
      }

      backupStatusData = await backupStatusPoll.json();
      backupStatus = Number(backupStatusData.is_completed);

      if (backupStatus === 0) {
        console.log("Polling backup status...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    return backupStatusData;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

async function generateAccessToken(email, apiKey) {
  const url = `https://api.cloudways.com/api/v1/oauth/access_token?email=${email}&api_key=${apiKey}`;
  let accessToken;
  try {
    accessToken = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        email: email,
        api_key: apiKey,
      },
    });
    return accessToken;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

async function triggerGitPull(
  serverId,
  appId,
  branchName,
  deployPath,
  email,
  apiKey
) {
  apiKey = getApiKey(apiKey);
  const url = `https://api.cloudways.com/api/v1/git/pull?server_id=${serverId}&app_id=${appId}&branch_name=${branchName}&deploy_path=${deployPath}`;
  try {
    const accessTokenResponse = await generateAccessToken(email, apiKey);
    const accessToken = await accessTokenResponse.json();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken.access_token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

async function triggerSync(
  serverId,
  appId,
  stagingServerId,
  stagingAppId,
  email,
  apiKey,
  action
) {
  apiKey = getApiKey(apiKey);
  const url = `https://api.cloudways.com/api/v1/sync/app?server_id=${serverId}&app_id=${appId}&source_server_id=${stagingServerId}&source_app_id=${stagingAppId}&action=${action}`;
  try {
    const accessTokenResponse = await generateAccessToken(email, apiKey);
    const accessToken = await accessTokenResponse.json();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken.access_token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Error during sync operation:", error);
    throw error;
  }
}

async function triggerCopyToStaging(
  serverId,
  appId,
  stagingServerId,
  stagingAppId,
  email,
  apiKey
) {
  return triggerSync(
    serverId,
    appId,
    stagingServerId,
    stagingAppId,
    email,
    apiKey,
    "pull"
  );
}

async function triggerCopyToLive(
  serverId,
  appId,
  stagingServerId,
  stagingAppId,
  email,
  apiKey,
  backup
) {
  return triggerSync(
    serverId,
    appId,
    stagingServerId,
    stagingAppId,
    email,
    apiKey,
    "push",
    backup
  );
}

async function deleteWebhook(webhookId) {
  let db;
  const collection = db.collection("cw-webhooks");
  try {
    db = await connectToDatabase("open");
    let webhook = await collection.deleteOne({ webhookId: webhookId });
    return webhook;
  } catch (error) {
    console.error("Error deleting webhook:", error);
    throw error;
  } finally {
    if (db) {
      await connectToDatabase("close");
    }
  }
}

async function getWebhook(webhookId) {
  let db;
  db = await connectToDatabase("open");
  const collection = db.collection("cw-webhooks");
  try {
    let webhook = await collection.findOne({ webhookId: webhookId });
    return webhook ? webhook : "Webhook not found";
  } catch (error) {
    console.error("Error fetching webhook:", error);
    throw error;
  } finally {
    if (db) {
      await connectToDatabase("close");
    }
  }
}

async function logRequest(req, db, type) {
  const log = db.collection("cw-logs");
  await log.insertOne({
    ...req.body,
    hostname: req.hostname,
    path: req.path,
    timestamp: new Date(),
    request_type: type,
  });
}
app.get("/", async (req, res) => {
  let db;
  try {
    db = await connectToDatabase("open");
    await logRequest(req, db, "visit");
  } catch (error) {
    console.error("Error logging visit:", error);
    return res.status(500).send("Internal Server Error.");
  } finally {
    if (db) {
      await connectToDatabase("close");
    }
  }
  res.send("Hello World!");
});

app.post("/webhook/add", async (req, res) => {
  if (req.body.secretKey !== secretKey) {
    return res.status(401).send("Unauthorized");
  }
  let db;
  delete req.body.secretKey;
  try {
    db = await connectToDatabase("open");
    let payload = { ...req.body, webhookId: ulid().toLowerCase() };
    const collection = db.collection("cw-webhooks");
    const result = await collection.insertOne(payload);
    const newWebhook = await collection.findOne({ _id: result.insertedId });
    res.status(200).json(newWebhook);
    await logRequest(req, db, "add webhook");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error.");
  } finally {
    if (db) {
      await connectToDatabase("close");
    }
  }
});

// TODO: Add ownership validation to prevent unauthorized updates
app.put("/webhook/:webhookId", async (req, res) => {
  if (req.body.secretKey != secretKey) {
    return res.status(401).send("Unauthorized");
  }

  let db;
  delete req.body.secretKey;
  try {
    db = await connectToDatabase();
    let webhookId = req.params.webhookId;
    let payload = req.body;
    const collection = db.collection("cw-webhooks");
    await collection.updateOne({ webhookId: webhookId }, { $set: payload });
    await logRequest(req, db, "update webhook");
    res.status(200).send("Webhook updated successfully.");
  } catch (error) {
    console.error("Error updating webhook:", error);
    res.status(500).send("Internal Server Error");
  } finally {
    if (db) {
      await connectToDatabase("close");
    }
  }
});

// TODO: Add ownership validation to prevent unauthorized deletions
app.delete("/webhook/:webhookId", async (req, res) => {
  if (req.body.secretKey != secretKey) {
    return res.status(401).send("Unauthorized");
  }
  return deleteWebhook(req.params.id);
});

app.post("/webhook/:webhookId/details", async (req, res) => {
  if (req.body.secretKey != secretKey) {
    return res.status(401).send("Unauthorized");
  }
  try {
    const webhook = await getWebhook(req.params.webhookId);
    if (webhook === "Webhook not found") {
      return res.status(404).send("Webhook not found");
    }
    return res.status(200).send(webhook);
  } catch (error) {
    console.error("Error fetching webhook details:", error);
    return res.status(500).send("Internal Server Error.");
  }
});

// Triggering the webhook does not require a secret key
app.post("/webhook/:webhookId", async (req, res) => {
  let db, result;
  try {
    db = await connectToDatabase("open");
    const webhookId = req.params.webhookId;
    const collection = db.collection("cw-webhooks");
    const record = await collection.findOne({ webhookId: webhookId });
    if (!record) {
      return res.status(404).send("Webhook not found");
    }

    switch (record.type) {
      case "deploy":
        if (record.backup) {
          try {
            let newBackup = await takeApplicationBackup(
              record.serverId,
              record.appId,
              record.apiKey,
              record.email
            );
          } catch (error) {
            console.error("Error taking backup:", error);
            return res.status(500).send("Error taking backup");
          }
        }
        result = await handleDeploy(record, res);
        break;
      case "copytolive":
        if (record.backup) {
          try {
            let newBackup = await takeApplicationBackup(
              record.serverId,
              record.appId,
              record.apiKey,
              record.email
            );
          } catch (error) {
            console.error("Error taking backup:", error);
            return res.status(500).send("Error taking backup");
          }
        }
        result = await handleCopyToLive(record, res);
        break;
      case "copytostaging":
        if (record.backup) {
          try {
            let newBackup = await takeApplicationBackup(
              record.serverId,
              record.appId,
              record.apiKey,
              record.email
            );
          } catch (error) {
            console.error("Error taking backup:", error);
            return res.status(500).send("Error taking backup");
          }
        }
        result = await handleCopyToStaging(record, res);
        break;
      default:
        return res.status(400).send("Invalid action type");
    }
  
    await logRequest(req, db, `trigger ${record.type} action`);
    return res.status(200).send(result);
  } catch (error) {
    console.error("Error processing action:", error);
    res.status(500).send("Internal Server Error.");
  } finally {
    if (db) {
      await connectToDatabase("close");
    }
  }
});

async function handleDeploy(record, res) {
  try {
    const deploy = await triggerGitPull(
      record.serverId,
      record.appId,
      record.branchName,
      record.deployPath,
      record.email,
      record.apiKey
    );
    res.status(200).send(deploy);
  } catch (error) {
    console.error("Error during deploy:", error);
    res.status(500).send("Error during deploy");
  }
}

async function handleCopyToLive(record, res) {
  try {
    const copyToLive = await triggerCopyToLive(
      record.serverId,
      record.appId,
      record.stagingServerId,
      record.stagingAppId,
      record.email,
      record.apiKey
    );
    res.status(200).send(copyToLive);
  } catch (error) {
    console.error("Error during copy to live:", error);
    res.status(500).send("Error during copy to live");
  }
}

async function handleCopyToStaging(record, res) {
  try {
    const copyToStaging = await triggerCopyToStaging(
      record.serverId,
      record.appId,
      record.stagingServerId,
      record.stagingAppId,
      record.email,
      record.apiKey
    );
    res.status(200).send(copyToStaging);
  } catch (error) {
    console.error("Error during copy to staging:", error);
    res.status(500).send("Error during copy to staging");
  }
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});
