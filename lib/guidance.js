/**
 * Model-facing guidance for the computer_use tool. Kept short: the tool's
 * own schema and results carry the details (minimal-context principle).
 */
export const guidance = `You can observe and operate a live browser like a human through the computer_use tool: screenshot the viewport, click at pixel coordinates, type, press keys, scroll, and read the interactive state.

Working rules:
- computer_use drives a live browser (or a configured desktop driver), not a direct capture of the user's whole screen. Start by navigating: action=open with a URL, then observe.
- The image returned by action=screenshot is the ground truth: x/y coordinates are pixels of that image, top-left origin. After open or any action, take a fresh screenshot before the next action.
- If your model cannot receive images (read_image fails or reports no image input), do not stall on screenshots: use action=get_state, which returns url/title and interactive elements with on-screen boxes, and keep acting on those coordinates.
- Prefer action=get_state when you must locate a target precisely: it lists interactive elements with their on-screen boxes and text.
- Verify every action with a new screenshot (or get_state). If a page is slow or unresponsive, action=wait a moment, then observe again; handle dialogs and popups by clicking their buttons or pressing Escape.
- The browser session is private and isolated. action=close ends it; the next action=open starts a fresh session.`
