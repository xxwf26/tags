import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { GalleryPage } from './pages/GalleryPage';
import { ArtistPage } from './pages/ArtistPage';
import { DiscoverPage } from './pages/DiscoverPage';
import { EntryDialog } from './components/EntryDialog';
import { useState } from 'react';

const queryClient = new QueryClient();

function NavBar() {
  const loc = useLocation();
  const back = loc.pathname !== '/';
  const [entry, setEntry] = useState(false);
  return (
    <>
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-stone-100">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center gap-3">
          {back && <Link to="/" className="text-stone-500 text-xl w-8">‹</Link>}
          <Link to="/" className="flex items-center gap-1.5 font-bold text-xhs text-lg">
            <span className="bg-xhs text-white w-7 h-7 rounded-lg flex items-center justify-center text-sm">画</span>画风库
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link to="/" className={`px-2.5 py-1 rounded-full ${loc.pathname === '/' ? 'text-xhs font-medium' : 'text-stone-500 hover:text-stone-800'}`}>画廊</Link>
            <Link to="/discover" className={`px-2.5 py-1 rounded-full ${loc.pathname === '/discover' ? 'text-xhs font-medium' : 'text-stone-500 hover:text-stone-800'}`}>发现</Link>
          </nav>
          <div className="flex-1 max-w-md mx-auto">
            <div className="bg-stone-100 rounded-full px-4 py-1.5 text-sm text-stone-400 flex items-center gap-2">🔍<span>搜画风 / 画师，如「油画」</span></div>
          </div>
          <button onClick={() => setEntry(true)} className="text-sm bg-xhs text-white px-3.5 py-1.5 rounded-full font-medium">＋ 录作品</button>
        </div>
      </header>
      {entry && <EntryDialog onClose={() => setEntry(false)} />}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <NavBar />
        <Routes>
          <Route path="/" element={<GalleryPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/artist/:id" element={<ArtistPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
