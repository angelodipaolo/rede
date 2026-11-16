import { render } from 'preact';
import { ReviewApp, ReviewList } from './components/App.tsx';
import './styles.css';
import './syntax.css';

const m = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
const root = document.getElementById('app')!;
if (m) render(<ReviewApp id={decodeURIComponent(m[1]!)} />, root);
else render(<ReviewList />, root);
