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
let connectionPromise = null;

async function connectToMongo() {
  if (db) return db;

  if (!connectionPromise) {
    client = new MongoClient(uri);
    connectionPromise = client.connect()
      .then(client => {
        db = client.db("concero_quiz");
        console.log("✅ Connected to MongoDB");
        return db;
      })
      .catch(err => {
        console.error("❌ MongoDB connection error:", err);
        connectionPromise = null; // Reset promise on failure
        throw err;
      });
  }

  return connectionPromise;
}

// --- Root route ---
app.get("/", (req, res) => {
  res.send("Concero × Lanca Quiz API is running...");
});


// --- DB Migration Helper ---
// DISABLED: Migration caused data pollution (all history set to now())
/*
async function migrateLeaderboardToResults(db) {
  const resultsColl = db.collection("results");
  const leaderboardColl = db.collection("leaderboard");

  const count = await resultsColl.countDocuments();
  if (count === 0) {
    console.log("⚠️ Results collection empty. Migrating from leaderboard...");
    const allLeaders = await leaderboardColl.find({}).toArray();
    if (allLeaders.length > 0) {
      const historyDocs = allLeaders.map(l => ({
        username: l.username,
        IQ: l.IQ,
        correct: l.correct,
        totalQuestions: l.totalQuestions,
        date: l.updatedAt || l.createdAt || new Date()
      }));
      await resultsColl.insertMany(historyDocs);
      console.log(`✅ Migrated ${historyDocs.length} records to history.`);
    }
  }
}
*/

// --- Debug Endpoint: Reset History ---
app.post("/api/debug/reset-history", async (req, res) => {
  try {
    const db = await connectToMongo();
    await db.collection("results").drop();
    res.json({ message: "History (results) cleared. All-Time (leaderboard) preserved." });
  } catch (error) {
    // NamespaceNotFound means already empty
    if (error.codeName === "NamespaceNotFound") {
      return res.json({ message: "History already empty." });
    }
    res.status(500).json({ error: error.message });
  }
});

// --- Submit Result (POST) ---
app.post("/api/submitResult", async (req, res) => {
  try {
    console.log("📥 Incoming data:", req.body);
    const { username, IQ, correct, totalQuestions } = req.body;

    if (!username || IQ === undefined || IQ === null) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const db = await connectToMongo();

    // 1. Save to History (Always)
    await db.collection("results").insertOne({
      username,
      IQ,
      correct,
      totalQuestions,
      date: new Date()
    });

    // 2. Update All-Time Leaderboard (Only if High Score)
    const leaderboard = db.collection("leaderboard");
    const existing = await leaderboard.findOne({ username });

    if (!existing) {
      await leaderboard.insertOne({
        username,
        IQ,
        correct,
        totalQuestions,
        updatedAt: new Date(),
      });
    } else {
      if (IQ > existing.IQ) {
        // Only update if we have a new high score
        const updateDoc = {
          $set: {
            IQ: IQ,
            correct: correct,
            totalQuestions: totalQuestions,
            updatedAt: new Date()
          }
        };
        await leaderboard.updateOne({ username }, updateDoc);
      }
      // If score is not higher, do nothing to preserve the original timestamp of the high score
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
    // Run migration check once connected
    // await migrateLeaderboardToResults(db); // DISABLED

    const timeframe = req.query.timeframe || "all";

    // --- DEBUG LOGGING ---
    console.log(`DEBUG: Fetching leaderboard for timeframe: ${timeframe}`);
    console.log(`DEBUG: Connected to DB: ${db.databaseName}`);
    const countLB = await db.collection("leaderboard").countDocuments();
    console.log(`DEBUG: 'leaderboard' count: ${countLB}`);
    const countRes = await db.collection("results").countDocuments();
    console.log(`DEBUG: 'results' count: ${countRes}`);
    // ---------------------

    if (timeframe === "tournament") {
      const tournamentId = getTournamentId();
      const results = await db.collection("tournament_results")
        .find({ tournamentId }) // Filter by current tournament ID
        .sort({ score: -1, submittedAt: 1 }) // Sort by Score DESC, then SubmittedAt ASC (First to submit)
        .limit(50)
        .toArray();

      // Map to match frontend structure
      const mapped = results.map(r => ({ ...r, IQ: r.score, isTournament: true, createdAt: r.submittedAt }));
      return res.json(mapped);
    }

    if (timeframe === "all") {
      const results = await db.collection("leaderboard")
        .find({})
        .sort({ IQ: -1, updatedAt: 1 }) // Sort by IQ DESC, then UpdatedAt ASC
        .limit(50)
        .toArray();
      return res.json(results);
    }

    // Aggregation for Daily/Weekly/Monthly
    let startDate = new Date();
    startDate.setUTCHours(0, 0, 0, 0); // Default to start of today UTC

    if (timeframe === "weekly") {
      startDate = new Date();
      startDate.setUTCDate(startDate.getUTCDate() - 7);
    } else if (timeframe === "monthly") {
      startDate = new Date();
      startDate.setUTCDate(startDate.getUTCDate() - 30);
    }

    // Aggregation Pipeline: Match Date -> Sort (Candidate) -> Group Max IQ -> Sort (Final) -> Limit
    const pipeline = [
      { $match: { date: { $gte: startDate } } },
      // Sort first to ensure $first in group picks the earliest top score
      { $sort: { IQ: -1, date: 1 } },
      {
        $group: {
          _id: "$username",
          IQ: { $first: "$IQ" }, // First because we sorted by IQ desc
          doc: { $first: "$$ROOT" } // First because we sorted by date asc (secondary)
        }
      },
      {
        $project: {
          username: "$_id",
          IQ: 1,
          correct: "$doc.correct",
          totalQuestions: "$doc.totalQuestions",
          createdAt: "$doc.date"
        }
      },
      { $sort: { IQ: -1, createdAt: 1 } }, // Final sort
      { $limit: 50 }
    ];

    const results = await db.collection("results").aggregate(pipeline).toArray();
    res.json(results);

  } catch (err) {
    console.error("Error fetching leaderboard:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// --- Helper: Get Tournament ID ---
function getTournamentId() {
  // Use start time as unique ID for the tournament session
  const startTimeStr = process.env.TOURNAMENT_START_UTC;
  if (!startTimeStr) return "default_tournament";
  return `tournament_${startTimeStr}`;
}

// --- Tournament Endpoints ---

// Get Tournament Status
app.get("/api/tournament-status", (req, res) => {
  const startTimeStr = process.env.TOURNAMENT_START_UTC;
  const startTime = startTimeStr ? new Date(startTimeStr) : null;

  if (!startTime) {
    return res.json({ status: "active", startTime: null, endTime: null }); // Default active if no config
  }

  const endTimeStr = process.env.TOURNAMENT_END_UTC;
  let endTime;

  if (endTimeStr) {
    endTime = new Date(endTimeStr);
  } else {
    endTime = new Date(startTime);
    endTime.setDate(endTime.getDate() + 7); // Default 7 days if not specified
  }

  const now = new Date();
  let status = "active";
  if (now < startTime) status = "upcoming";
  if (now > endTime) status = "ended";

  res.json({ status, startTime, endTime });
});

// Check if user has played
app.post("/api/tournament-check", async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ message: "Username required" });

    const db = await connectToMongo();
    const tournamentId = getTournamentId();

    // Check for participation IN THIS SPECIFIC TOURNAMENT ID
    const existing = await db.collection("tournament_results").findOne({
      username,
      tournamentId
    });

    res.json({ hasPlayed: !!existing });
  } catch (error) {
    console.error("Error checking tournament status:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Submit Tournament Result
app.post("/api/submitTournamentResult", async (req, res) => {
  try {
    const { username, score, timeSpent, correct, totalQuestions } = req.body;

    if (!username) return res.status(400).json({ message: "Missing fields" });

    const db = await connectToMongo();
    const collection = db.collection("tournament_results");
    const tournamentId = getTournamentId();

    // Check if already played THIS TOURNAMENT
    const existing = await collection.findOne({ username, tournamentId });
    if (existing) {
      return res.status(403).json({ message: "You have already participated in this tournament." });
    }

    await collection.insertOne({
      username,
      tournamentId, // Save the ID to bucket results
      score, // Calculated score (IQ or points)
      correct,
      totalQuestions,
      timeSpent,
      submittedAt: new Date(),
    });

    res.status(200).json({ message: "Tournament result saved!" });
  } catch (error) {
    console.error("Error submitting tournament result:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
