require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


const app = express();

const TOKEN_FILE = "whoopTokens.json";

let whoopTokens = null;
let oauthState = null;

// Load tokens from file
if (fs.existsSync(TOKEN_FILE)) {
  whoopTokens = JSON.parse(fs.readFileSync(TOKEN_FILE));
  console.log("Tokens loaded from file");
}

// Save tokens to file
function saveTokens(tokens) {
  whoopTokens = tokens;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log("Tokens saved to file");
}
  
// Refresh access token
async function refreshAccessToken() {
  try {
    const response = await axios.post(
      `${process.env.WHOOP_API_HOSTNAME}/oauth/oauth2/token`,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: whoopTokens.refresh_token,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    saveTokens(response.data);
    console.log("Access token refreshed");
  } catch (error) {
    console.error("Refresh failed:", error.response?.data || error.message);
  }
}

// Whoop GET request
async function whoopGet(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${whoopTokens.access_token}`,
      },
    });

    return response.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("Token expired. Refreshing...");
      await refreshAccessToken();

      const retry = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${whoopTokens.access_token}`,
        },
      });

      return retry.data;
    }

    console.error("Err:", err.response?.data || err.message);
    throw err;
  }
}

// Auth Whoop
app.get("/auth/whoop", (req, res) => {
  oauthState = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.CLIENT_ID,
    redirect_uri: process.env.CALLBACK_URL,
    scope:
      "offline read:recovery read:sleep read:workout read:profile read:body_measurement read:cycles",
    state: oauthState,
  });

  const authURL = `${process.env.WHOOP_API_HOSTNAME}/oauth/oauth2/auth?${params.toString()}`;

  console.log("Redirecting to WHOOP...");
  res.redirect(authURL);
});

// Callback
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) return res.send("No authorization code received.");
  if (state !== oauthState) return res.send("Invalid state.");

  try {
    const tokenResponse = await axios.post(
      `${process.env.WHOOP_API_HOSTNAME}/oauth/oauth2/token`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.CALLBACK_URL,
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    saveTokens(tokenResponse.data);

    res.send("WHOOP connected successfully! You can close this tab.");
  } catch (error) {
    console.error("Token exchange failed:", error.response?.data || error.message);
    res.status(500).send("Token exchange failed.");
  }
});

// Latest cycle (includes recovery + strain)
app.get("/test-recovery", async (_, res) => {
  if (!whoopTokens) return res.send("Connect WHOOP first at /auth/whoop");

  try {
    const data = await whoopGet(
        "https://api.prod.whoop.com/developer/v2/recovery"
    );
    res.json(data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

// Latest sleep
app.get("/test-sleep", async (_, res) => {
  if (!whoopTokens) return res.send("Connect WHOOP first at /auth/whoop");

  try {
    const data = await whoopGet(
      "https://api.prod.whoop.com/developer/v1/activity/sleep?limit=1"
    );
    res.json(data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

// Latest workouts
app.get("/test-workouts", async (_, res) => {
  if (!whoopTokens) return res.send("Connect WHOOP first at /auth/whoop");

  try {
    const data = await whoopGet(
      "https://api.prod.whoop.com/developer/v1/activity/workout"
    );
    res.json(data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

// Body measurement
app.get("/test-body", async (_, res) => {
  if (!whoopTokens) return res.send("Connect WHOOP first at /auth/whoop");

  try {
    const data = await whoopGet(
      "https://api.prod.whoop.com/developer/v1/user/body_measurement"
    );
    res.json(data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

function buildPerformanceSummary(recovery) {
    console.log("\n========= RECOVERY =========\n");
    console.log(recovery);
    console.log("\n===================================\n");

    return recovery;
}
  
  async function generateCoachPlan(summary) {
    const prompt = `
  You are an elite hybrid athlete performance coach.
  
  Athlete Data:
  ${JSON.stringify(summary, null, 2)}
  
  Based on recovery, strain, sleep and load:
  
  Provide:
  1. Tomorrow workout intensity (Low / Moderate / High)
  2. Training recommendation
  3. Calorie target
  4. Protein target
  5. Carb adjustment
  6. Sleep target (hours)
  7. Recovery protocol
  
  Keep it structured and concise.
  `;
  
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a data-driven performance coach." },
        { role: "user", content: prompt }
      ],
    });
  
    return response.choices[0].message.content;
}

// Coach
app.get("/run-coach", async (_, res) => {
  if (!whoopTokens) return res.send("Connect WHOOP first at /auth/whoop");

  try {
    // const cycle = await whoopGet(
    //   "https://api.prod.whoop.com/developer/v1/cycles"
    // );

    // const sleep = await whoopGet(
    //   "https://api.prod.whoop.com/developer/v1/activity/sleep?limit=1"
    // );

    const recovery = await whoopGet(
      "https://api.prod.whoop.com/developer/v2/recovery"
    );

    // const body = await whoopGet(
    //   "https://api.prod.whoop.com/developer/v1/user/body_measurement"
    // );

    const summary = buildPerformanceSummary(recovery);
    const aiPlan = await generateCoachPlan(summary);

    res.json({
        performance_summary: summary,
        ai_plan: aiPlan
      });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

// Start server
app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
