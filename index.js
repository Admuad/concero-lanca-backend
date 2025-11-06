import express from "express";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const uri = process.env.MONGODB_URI;
let client;
let db;

// Persistent MongoDB connection
async function connectToMongo() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db("concero_quiz");
    console.log("✅ Connected to MongoDB");
  }
  return db;
}

// --- Root route ---
app.get("/", (req, res) => {
  res.send("Concero × Lanca Quiz API is running...");
});

// --- Submit Result (POST) ---
app.post("/api/submitResult", async (req, res) => {
  try {
    console.log("📥 Incoming data:", req.body); 
    const { username, IQ, correct, totalQuestions } = req.body;

    if (!username || !IQ) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const db = await connectToMongo();
    const leaderboard = db.collection("leaderboard");

    // Upsert logic — update only if the new IQ is higher
    const existing = await leaderboard.findOne({ username });
    if (!existing || IQ > existing.IQ) {
      await leaderboard.updateOne(
        { username },
        {
          $set: {
            username,
            IQ,
            correct,
            totalQuestions,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
    }

    res.status(200).json({ message: "Result saved successfully" });
  } catch (error) {
    console.error("Error saving result:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// --- Leaderboard (GET) ---
app.get("/api/leaderboard", async (req, res) => {
  try {
    const db = await connectToMongo();
    const leaderboard = db.collection("leaderboard");

    const results = await leaderboard
      .find({})
      .sort({ IQ: -1 })
      .limit(50)
      .toArray();

    res.json(results);
  } catch (err) {
    console.error("Error fetching leaderboard:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
