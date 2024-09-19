// TODO: Implement triggerCopyToLive and triggerCopyToStaging functions
// TODO: Implement data validation for incoming webhooks
// TODO: Send an email everytime the webhook fails and deactivate the webhook

import { MongoClient } from "mongodb";
import { ulid } from "ulid";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

let dbClient;
const app = express();
const port = process.env.PORT || 3000;
const secret_key = process.env.SECRET_KEY;

app.use(express.json());

async function connectToDatabase(op = "open") {
  const url = process.env.DATABASE_URL;
  const dbName = "cw-webhook-listener";

  if (op === "open") {
    if (!dbClient) {
      dbClient = new MongoClient(url, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
    }

    try {
      if (!dbClient.isConnected()) {
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
    if (dbClient && dbClient.isConnected()) {
      try {
        await dbClient.close();
        console.log("Connection to MongoDB closed.");
      } catch (error) {
        console.error("Error closing MongoDB connection:", error);
        throw error;
      }
    }
  }
}

async function takeApplicationBackup(server_id, app_id, api_key, email) {
  const url = `https://api.cloudways.com/api/v1/app/manage/takeBackup?server_id=${server_id}&app_id=${app_id}`;
  try {
    const access_token = generateAccessToken(email, api_key);
    const takeBackupResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!takeBackupResponse.ok) {
      throw new Error(`HTTP error! status: ${takeBackupResponse.status}`);
    }

    const backupDetails = await takeBackupResponse.json();
    const backupStatusUrl = `https://api.cloudways.com/api/v1/operation/${backupDetails.operation_id}`;
    let backupStatus = 0;
    let backupStatusPoll;

    while (backupStatus === 0) {
      backupStatusPoll = await fetch(backupStatusUrl, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
      });

      if (!backupStatusPoll.ok) {
        throw new Error(`HTTP error! status: ${backupStatusPoll.status}`);
      }

      const backupStatusData = await backupStatusPoll.json();
      backupStatus = Number(backupStatusData.is_completed);

      if (backupStatus === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log("Polling backup status...");
      }
    }

    return backupStatusPoll.json();
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

async function generateAccessToken(email, api_key) {
  const url = `https://api.cloudways.com/api/v1/oauth/access_token?email=${email}&api_key=${api_key}`;
  try {
    const access_token = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    return access_token;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

async function triggerGitPull(
  server_id,
  app_id,
  branch_name,
  deploy_path,
  api_key,
  email
) {
  const url = `https://api.cloudways.com/api/v1/git/pull?server_id=${server_id}&app_id=${app_id}&branch_name=${branch_name}&deploy_path=${deploy_path}`;
  try {
    const access_token = generateAccessToken(email, api_key);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
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

app.get("/", (req, res) => {
  res.send("Hello World! The API for managing Cloudways webhooks is running.");
});

app.post("/webhook/new", async (req, res) => {
  if (req.body.secret_key !== secret_key) {
    return res.status(401).send("Unauthorized");
  }

  let db;
  try {
    db = await connectToDatabase("open");
    let payload = req.body;
    payload.id = ulid();
    console.log("Received payload:", payload);

    const collection = db.collection("cw-webhooks");
    const log = db.collection("cw-logs");

    await collection.insertOne(payload);
    await log.insertOne({ ...payload, timestamp: new Date() });

    res.status(200).send("New webhook received and added to the database");
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
app.put("/webhook/:id", async (req, res) => {
  if (req.body.secret_key != secret_key) {
    return res.status(401).send("Unauthorized");
  }

  let db;
  try {
    db = await connectToDatabase();
    let id = req.params.id;
    let payload = req.body;
    const collection = db.collection("cw-webhooks");
    await collection.updateOne({ id: id }, { $set: payload });
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
app.delete("/webhook/:id", async (req, res) => {
  if (req.body.secret_key != secret_key) {
    return res.status(401).send("Unauthorized");
  }

  let db;
  try {
    db = await connectToDatabase();
    let id = req.params.id;
    const collection = db.collection("cw-webhooks");
    await collection.deleteOne({ id: id });
    res.status(200).send("Webhook deleted successfully.");
  } catch (error) {
    console.error("Error deleting webhook:", error);
    res.status(500).send("Internal Server Error");
  } finally {
    if (db) {
      await connectToDatabase("close");
    }
  }
});

app.post("/webhook/:id", async (req, res) => {
  let db;
  try {
    db = await connectToDatabase("open");
    const id = req.params.id;
    const collection = db.collection("cw-webhooks");
    const record = await collection.findOne({ id: id });

    if (!record) {
      return res.status(404).send("Record not found");
    }

    await takeApplicationBackup(record.server_id, record.app_id, record.api_key, record.email);

    switch (record.type) {
      case "deploy":
        return await handleDeploy(record, res);
      case "copytolive":
        return await handleCopyToLive(record, res);
      case "copytostaging":
        return await handleCopyToStaging(record, res);
      default:
        return res.status(400).send("Invalid action type");
    }
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
    const deploy = await triggerGitPull(record.server_id, record.app_id, record.branch_name, record.deploy_path);
    res.status(200).send(deploy);
  } catch (error) {
    console.error("Error during deploy:", error);
    res.status(500).send("Error during deploy");
  }
}

async function handleCopyToLive(record, res) {
  try {
    const copytolive = await triggerCopyToLive(record.server_id, record.app_id, record.branch_name, record.deploy_path);
    res.status(200).send(copytolive);
  } catch (error) {
    console.error("Error during copy to live:", error);
    res.status(500).send("Error during copy to live");
  }
}

async function handleCopyToStaging(record, res) {
  try {
    const copytostaging = await triggerCopyToStaging(record.server_id, record.app_id, record.branch_name, record.deploy_path);
    res.status(200).send(copytostaging);
  } catch (error) {
    console.error("Error during copy to staging:", error);
    res.status(500).send("Error during copy to staging");
  }
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});
