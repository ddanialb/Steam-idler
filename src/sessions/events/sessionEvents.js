/*
 * File: sessionEvents.js
 * Project: steam-idler
 * Created Date: 2022-10-09 12:52:30
 * Author: 3urobeat
 *
 * Last Modified: 2026-01-14 21:30:14
 * Modified By: 3urobeat
 *
 * Copyright (c) 2022 - 2026 3urobeat <https://github.com/3urobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


const sessionHandler = require("../sessionHandler.js");


sessionHandler.prototype._attachEvents = function() {

    this.session.on("authenticated", () => { // Success
        if (global.renderQrChallenges) delete global.renderQrChallenges[this.logOnOptions.accountName]; // RENDER: QR approved, remove from panel
        if (global.render2FAPending) delete global.render2FAPending[this.logOnOptions.accountName];     // RENDER: guard code accepted

        try { logger.stopReadInput("Login request accepted"); } catch (e) { /* no readInput active on servers */ }

        logger("debug", `[${this.logOnOptions.accountName}] getRefreshToken(): Login request successful, '${this.session.accountName}' authenticated. Resolving Promise...`);

        this._resolvePromise(this.session.refreshToken);
    });


    this.session.on("timeout", () => { // Login attempt took too long, failure
        if (global.renderQrChallenges) delete global.renderQrChallenges[this.logOnOptions.accountName]; // RENDER: clear pending QR from panel
        if (global.render2FAPending) delete global.render2FAPending[this.logOnOptions.accountName];     // RENDER: clear pending guard prompt

        logger("warn", `[${this.logOnOptions.accountName}] Login attempt timed out!`);

        this._resolvePromise(null);

        // RENDER: Retry QR logins automatically so a missed scan doesn't leave the account skipped forever
        if (this.logOnOptions.password == "qrcode") {
            logger("info", `[${this.logOnOptions.accountName}] QR login will automatically retry in 60 seconds...`);
            setTimeout(() => this.bot.login(), 60000);
        }
    });


    this.session.on("error", (err) => { // Failure
        if (global.render2FAPending) delete global.render2FAPending[this.logOnOptions.accountName]; // RENDER: clear pending guard prompt on failure

        logger("error", `[${this.logOnOptions.accountName}] Failed to get a session for account '${this.logOnOptions.accountName}'! Error: ${err.stack ? err.stack : err}`); // Session.accountName is only defined on success

        // TODO: When does this event fire? Do I need to do something else?
        // TODO: Retry until advancedconfig.maxLogOnRetries?

        this._resolvePromise(null);
    });

};
