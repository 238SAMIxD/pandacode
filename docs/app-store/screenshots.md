# App Store screenshots

## Sizes

| Display | Pixels (portrait) | Needed |
|---|---|---|
| iPhone 6.9-inch (iPhone 17 Pro Max, 16 Pro Max) | **1320 × 2868** | **Yes**, 3 to 10 shots |
| iPhone 6.5-inch | 1284 × 2778 or 1242 × 2688 | No: App Store Connect scales the 6.9-inch set down for every smaller iPhone |
| iPad 13-inch | 2064 × 2752 | **No** |

Why no iPad: `mobile/app.json` sets `ios.supportsTablet: false`, so the build is iPhone only.
App Store Connect then asks for no iPad screenshots. iPads can still install it and run it in
the iPhone-size window; that needs nothing from us. If `supportsTablet` ever becomes `true`,
the 13-inch iPad set becomes required and the split view (`src/ui/split.tsx`) is the layout to
shoot.

Rules:

- PNG or JPEG, RGB, no transparency, exactly 1320 × 2868. A wrong size fails the upload.
  The six files below are 1320 × 2868 PNGs with no alpha channel (checked with
  `sips -g pixelWidth -g pixelHeight -g hasAlpha docs/app-store/screenshots/*.png`).
- Portrait only (the app is portrait only).
- Real app UI from the demo (Explore the demo, or `EXPO_PUBLIC_PANDACODE_DEMO=1`). The demo's
  computers, projects and logins are fictional, so no personal data shows. A caption and a
  phone frame around the UI are fine; don't show features the app doesn't have (2.3.3).
- Status bar in captures: full battery, full signal, 9:41. In the simulator:
  `xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3`.
- Order matters: the first three show in search results. Upload them in file order.

## The set

Files are in `docs/app-store/screenshots/`. Each is a two-line caption above a phone frame
holding one capture from `docs/app-store/mockups/captures/`. Light and dark alternate.

| # | File | Capture | Caption (line 1 / line 2) |
|---|---|---|---|
| 1 | `01-inbox.png` | `inbox-light.png`: the Inbox across computers | Every agent, / one inbox. |
| 2 | `02-task.png` | `task-dark.png`: a task's conversation | Talk to the agent, / not the laptop. |
| 3 | `03-approval.png` | `approval-light.png`: a task waiting on an approval | Approve tool calls / from anywhere. |
| 4 | `04-working.png` | `working-dark.png`: a run in progress | Watch it work, / live. |
| 5 | `05-new-task.png` | `new-task-light.png`: New task, choosing a computer | Pick a computer, / start a task. |
| 6 | `06-settings.png` | `settings-dark.png`: Settings, appearance and wallpaper | Light, dark, wallpaper. / Make it yours. |

## Re-rendering

Sources are in `docs/app-store/mockups/`: `index.html` (the page; `index.html?<n>` shows shot
n, and the `shots` table in it holds each caption and capture), `mockup.css` (layout and type)
and `captures/` (the raw app screenshots, one per shot). To change a caption, edit `shots`; to
change a screen, replace its capture with a new screenshot of the same name.

Then, from the repo root:

```sh
node docs/app-store/mockups/render.mjs
```

It uses the repo's Playwright with Google Chrome (`channel: 'chrome'`, as the Playwright
suites do), opens each page at 1320 × 2868 and writes `docs/app-store/screenshots/01-inbox.png`
… `06-settings.png`, replacing the old files. Open one to check it before uploading.

## App preview video (optional)

Not planned for 1.0. If you add one: 886 × 1920 portrait, 15–30 s, H.264, recorded from the demo.
