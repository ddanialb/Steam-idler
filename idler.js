/*
 * File: idler.js
 * Project: steam-idler
 * Created Date: 2021-03-31 21:05:47
 * Author: 3urobeat
 *
 * Render edition: env-based config, token seeding & a full control panel (panel.js)
 */


// --- RENDER: let environment variables override config.json (keeps secrets out of the repo!) ---
const config = require("./config.json");

// PLAYING_GAMES="730" or "730,440"
if (process.env.PLAYING_GAMES) {
    config.playingGames = process.env.PLAYING_GAMES
        .split(",")
        .map(e => e.trim())
        .filter(e => e.length > 0)
        .map(e => (/^\d+$/.test(e) ? parseInt(e, 10) : e));
}

if (process.env.ONLINE_STATUS) config.onlinestatus = parseInt(process.env.ONLINE_STATUS, 10);
if (process.env.AFK_MESSAGE !== undefined) config.afkMessage = process.env.AFK_MESSAGE;


// --- Start the bot core + control panel ---
const controller = require("./src/controller.js");

// RENDER: Seed refresh tokens from REFRESH_TOKENS env var into tokens.db before starting.
// (Workaround for Steam blocking QR/password logins from datacenter IPs: generate the token
// on your own PC at home once, then provide it here. Format: user1:token1,user2:token2)
async function seedRefreshTokensFromEnv() {
    if (!process.env.REFRESH_TOKENS) return;

    const nedb = require("@seald-io/nedb");
    const db = new nedb({ filename: "./src/tokens.db" });
    await db.loadDatabaseAsync();

    const entries = process.env.REFRESH_TOKENS.split(/[\r\n,]+/).map(e => e.trim()).filter(e => e.includes(":"));

    for (const entry of entries) {
        const accountName = entry.slice(0, entry.indexOf(":"));
        const token       = entry.slice(entry.indexOf(":") + 1).trim();
        if (!accountName || !token.includes(".")) continue; // refresh tokens are JWTs and contain dots

        const exists = await db.findOneAsync({ accountName });

        if (exists) {
            await db.updateAsync({ accountName }, { $set: { token } });
            console.log(`[env] Updated stored refresh token for '${accountName}'`);
        } else {
            await db.insertAsync({ accountName, token });
            console.log(`[env] Seeded refresh token for '${accountName}' from REFRESH_TOKENS env var`);
        }
    }

    await db.persistence.compactDatafileAsync();
}

seedRefreshTokensFromEnv()
    .catch((err) => console.log("Failed to seed REFRESH_TOKENS: " + err))
    .finally(() => {
        controller.start();

        // Start the control panel (health check + dashboard with login, game search, timers, ...)
        require("./panel.js").attach(controller, config);
    });
