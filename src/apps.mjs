// Known Tizen app IDs. TVs from 2022 on no longer answer the installed-apps request
// (`ed.installedApp.get`) over the WebSocket, but they still confirm apps one by one at
// GET /api/v2/applications/<id>, and the display name comes from the TV itself.
// Missing an app? Pass its ID in SAMSUNG_TV_EXTRA_APPS (comma separated).
export const KNOWN_APP_IDS = [
  '3201907018807', '11101200001', // Netflix
  '111299001912', // YouTube
  '3201707014489', // YouTube TV
  '3201611010983', // YouTube Kids
  '3201910019365', '3201512006785', // Prime Video
  '3201901017640', '3202009021709', '3202204027038', // Disney+
  '3202301029760', // Max
  '3201807016597', // Apple TV
  '3201908019041', // Apple Music
  '3201606009684', // Spotify
  '3201608010191', // Deezer
  '3201710014874', // Amazon Music
  '3202203026841', // Twitch
  '3202008021577', // TikTok
  '3202302030097', // Crunchyroll
  '3201710014981', '3202110025305', // Paramount+
  '3201808016802', // Pluto TV
  '3201504001965', // Tubi
  '3201803015944', '3202006021105', // Discovery+
  '3201806016390', // DAZN
  '3201512006963', // Plex
  '3202203026799', // Xbox
  '3202102023078', // GeForce NOW
  '3201907018784', '3202010022079', // Internet browser
  '3201710015037', // Gallery
  '3201710015016', '3201910019378', '3202311033054', // SmartThings
];
