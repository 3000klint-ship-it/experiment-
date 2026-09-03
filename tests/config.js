// UNO Lounge test build configuration.
// The test build is a config-driven variant of the main game that adds
// auto-playing bots so game logic can be exercised without real players.
//
// Set TEST_MODE=1 instead of running files which are near-duplicates of the
// main server. `node server.js` runs with bots enabled by default here.
module.exports = {
  TEST_MODE: process.env.TEST_MODE !== "0",
  BOT_COUNT: Number(process.env.BOT_COUNT || 5),
  MAX_PLAYERS: Number(process.env.MAX_PLAYERS || 14),
  BOT_AVATARS: [
    "avatar1.jpg","avatar2.jpg","avatar3.jpg",
    "avatar4.jpg","avatar5.jpg","avatar6.jpg"
  ]
};
