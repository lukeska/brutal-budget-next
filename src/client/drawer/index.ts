import { EntryDrawer } from "./EntryDrawer";
import { registerDrawer } from "./store";

// Imported once by the app entry: plugs the entry drawer into the shell's DrawerHost.
registerDrawer(EntryDrawer);
