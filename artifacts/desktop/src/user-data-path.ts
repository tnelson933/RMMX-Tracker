// Keep the desktop app's data folder at its pre-rename location.
//
// The app was renamed from "RM Tracker" to "RM Roost". Electron derives the
// userData folder from the product name, so without this, existing installs
// would open an empty folder and lose their saved login and offline race data
// (race_data.db). Imported first in main.ts so it runs before any module reads
// app.getPath("userData").
import { app } from "electron";
import path from "path";

app.setPath("userData", path.join(app.getPath("appData"), "RM Tracker"));
