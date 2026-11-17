import { render } from 'preact';
import { ReviewApp, ReviewList } from './components/App.tsx';
import { HistoryApp } from './components/History.tsx';
import './styles.css';
import './syntax.css';

const m = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
const root = document.getElementById('app')!;
if (m) render(<ReviewApp id={decodeURIComponent(m[1]!)} />, root);
else if (/^\/history\/?$/.test(location.pathname)) render(<HistoryApp />, root);
else render(<ReviewList />, root);
