# Web-to-Android Migration Experience & Transfer Guide

This document summarizes the core UI/UX and technical lessons learned from migrating the web application to the Android application in `project_InzaiCapRec`, and outlines how you can seamlessly transfer this experience to your new project `project_FR5` using Antigravity.

---

## 1. Core Lessons Learned (from InzaiCapRec)

During the migration of the Web app (Next.js/React) to React Native (Android), several key issues were identified and resolved. You should apply these same patterns to `project_FR5`.

### 📱 UI/UX for Field Operations & Senior Users
*   **Avoid Icon-Only Buttons:** Elderly or field operators often find icons ambiguous. Replace or supplement icons with clear **text labels** (e.g., instead of just a gear icon, use a button with "初期設定" or both).
*   **Outlined and Large Tap Targets:** Enclose text buttons with outlines and ensure a large touch target area (minimum 48x48 dp) to prevent misclicks.
*   **High Contrast & Readability:** Keep fonts large (e.g., base font size around `19px` / `19.2px`) and use high-contrast color palettes suited for outdoor sunlight visibility (e.g., gentle green `#E0F2E9` backgrounds with pure black text `#000000`).

### 📷 Camera & Media Handling (Memory Optimization)
*   **Avoid Direct High-Res Raw Uploads:** On mobile browsers (Safari/Chrome), setting `<input capture="environment">` or uploading multi-megapixel images directly can trigger Out-Of-Memory (OOM) crashes.
*   **Image Compression:** In React Native, always use a library like `react-native-image-resizer` or compress images programmatically before upload to reduce memory footprint and bandwidth usage.
*   **Serial Upload Queue (Crucial):** Never run high-volume uploads in parallel using `Promise.all` (e.g., uploading 4 large photos at once). Cellular networks are unstable. Use **sequential execution** (a loop/queue uploading one photo at a time) and show clear progress feedback.

### 🔒 Firebase & Network Resilience
*   **URL Safety for File Names:** Ensure all files uploaded to Firebase Storage have their paths URL-encoded (using `encodeURIComponent`). Spaces or special characters (like Japanese text in individual IDs) can break Storage paths.
*   **Robust Input Validation:** Do not rely solely on simple UI hints. Always pop up a clear toast or modal explaining which required fields are missing before attempting network submissions.

---

## 2. How to Transfer this Experience to `project_FR5`

Antigravity can automatically inherit these rules if you set up the workspace files correctly. Here are the three best methods to carry over this knowledge:

### Method A: Custom Workflow (Recommended ⭐️)
You can create a custom workflow file in your new project. When Antigravity starts in `project_FR5`, it automatically indexes workflow files inside the `.agents/workflows` directory.

1. Create a directory: `project_FR5/.agents/workflows/`
2. Create a markdown file: `web-to-android-migration.md`
3. Paste the contents of this transfer guide and your previous `docs/agent_log.md` into it.
4. When you prompt the agent in `project_FR5`, simply tell it:
   > "Use the migration workflow guidelines in `.agents/workflows/web-to-android-migration.md` to guide the migration."

### Method B: Sharing Documentation Files
Simply copy the entire `docs/` folder from `project_InzaiCapRec` into `project_FR5`.
*   `docs/agent_log.md` (Logs of fixes, package-lock issues, iOS camera issues, sequential upload changes)
*   `docs/blueprint.md` (App style and structural specifications)

When starting a conversation in `project_FR5`, mention:
> "Please read `docs/agent_log.md` to understand our previous failures and improvements before writing any code."

### Method C: Custom Skill Creation
If you want to automate parts of the migration process (e.g., running specific CLI setup sequences or validation scripts), you can create a custom Antigravity skill in `project_FR5/.agents/skills/`.
*   Antigravity will scan `.agents/skills/<skill-name>/SKILL.md` and load it as a specialized capability.

---

## 3. Checklist for `project_FR5` Migration Setup

When you start `project_FR5`, follow this sequence:

1.  **Environment Setup**: Verify Node/npm versions and clean up any accidental root-level `package-lock.json` or `node_modules` (a common mistake listed in `agent_log.md`).
2.  **App Hosting & Backend Sync**: Align Firebase rule files (`firestore.rules`, `storage.rules`) with the new project IDs.
3.  **UI Base Layout**: Establish your color tokens and typography first in your React Native design system, ensuring outlined buttons and readable text.
4.  **Sequential Async Handlers**: Write helpers for network requests and uploads using sequential processing from the start.
