import express from "express";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

app.get("/", (req, res) => {
  res.send("Concero Quiz API is running...");
});

app.get("/api/leaderboard", async (req, res) => {
  try {
    await client.connect();
    const db = client.db("concero_quiz");
    const leaderboard = db.collection("leaderboard");

    const results = await leaderboard
      .aggregate([
        { $sort: { IQ: -1 } },
        { $group: { _id: "$username", highestIQ: { $max: "$IQ" }, doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
        { $sort: { IQ: -1 } },
      ])
      .toArray();

    res.json(results);
  } catch (err) {
    console.error("Error fetching leaderboard:", err);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    await client.close();
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
