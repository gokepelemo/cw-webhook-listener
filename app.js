// TODO: Implement triggerCopyToLive and triggerCopyToStaging functions
// TODO: Implement data validation for incoming webhooks

import { MongoClient } from "mongodb";
import { ulid } from "ulid";
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const secret_key = process.env.SECRET_KEY;

app.use(express.json());

async function connectToDatabase() {
  const url = process.env.DATABASE_URL;
  const client = new MongoClient(url, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  try {
    await client.connect();
    console.log("Connected successfully to MongoDB");
    const db = client.db("cw-webhook-listener");
    return db;
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    throw error;
  }
}

async function generateAccessToken(email, api_key) {
  try {
    const access_token = await fetch(
      `https://api.cloudways.com/api/v1/oauth/access_token?email=${email}&api_key=${api_key}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
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
  if (req.body.secret_key != secret_key) {
    res.status(401).send("Unauthorized");
  }
  try {
    const db = await connectToDatabase();
    let payload = req.body;
    payload.id = ulid();
    console.log("Received payload:", payload);
    const collection = db.collection("cw-webhooks");
    await collection.insertOne(payload);
    res.status(200).send("New webhook received and added to the database");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error.");
  }
});

// TODO: Add ownership validation to prevent unauthorized updates
app.put("/webhook/:id", async (req, res) => {
  if (req.body.secret_key != secret_key) {
    res.status(401).send("Unauthorized");
  }
  try {
    const db = await connectToDatabase();
    let id = req.params.id;
    let payload = req.body;
    const collection = db.collection("cw-webhooks");
    await collection.updateOne({ id: id }, { $set: payload });
    res.status(200).send("Webhook updated successfully.");
  } catch (error) {
    console.error("Error updating webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

// TODO: Add ownership validation to prevent unauthorized deletions
app.delete("/webhook/:id", async (req, res) => {
  if (req.body.secret_key != secret_key) {
    res.status(401).send("Unauthorized");
  }
  try {
    const db = await connectToDatabase();
    let id = req.params.id;
    const collection = db.collection("cw-webhooks");
    await collection.deleteOne({ id: id });
    res.status(200).send("Webhook deleted successfully.");
  } catch (error) {
    console.error("Error deleting webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/webhook/:id", async (req, res) => {
  try {
    const db = await connectToDatabase();
    let id = req.params.id;
    const collection = db.collection("cw-webhooks");
    const record = await collection.findOne({ id: id });
    switch (record.type) {
      case "deploy":
        let deploy = await triggerGitPull(
          record.server_id,
          record.app_id,
          record.branch_name,
          record.deploy_path
        );
        res.status(200).send(deploy);
        break;
      case "copytolive":
        let copytolive = await triggerCopyToLive(
          record.server_id,
          record.app_id,
          record.branch_name,
          record.deploy_path
        );
        res.status(200).send(copytolive);
        break;
      case "copytostaging":
        let copytostaging = await triggerCopyToStaging(
          record.server_id,
          record.app_id,
          record.branch_name,
          record.deploy_path
        );
        res.status(200).send(copytostaging);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error("Error processing action.", error);
    res.status(500).send("Internal Server Error.");
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}.`);
});
