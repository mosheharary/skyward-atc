// Entry point: boot the application shell.

import './ui/style.css';
import { App } from './app/App';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

const root = document.getElementById('app')!;
root.replaceChildren();
if (!webglAvailable()) {
  root.innerHTML = '<div class="boot err">Skyward ATC needs a browser with WebGL 2 (Chrome, Edge, Firefox or Safari).</div>';
} else {
  const app = new App(root);
  void app.start();
}
