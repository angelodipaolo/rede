import { render } from 'preact';
import { ReviewApp, ReviewList } from './components/App.tsx';
import { HistoryApp } from './components/History.tsx';
import './styles.css';
import './syntax.css';

import { setWorkspace } from './api.ts';

// /w/<workspace>/r/<review>, /w/<workspace>/history, /w/<workspace>, / (dashboard)
const m = /^\/w\/([^/]+)(?:\/(r\/([^/]+)|history))?\/?$/.exec(location.pathname);
const root = document.getElementById('app')!;
if (m) setWorkspace(decodeURIComponent(m[1]!));
if (m?.[3]) render(<ReviewApp id={decodeURIComponent(m[3])} />, root);
else if (m?.[2] === 'history') render(<HistoryApp />, root);
else render(<ReviewList />, root);
