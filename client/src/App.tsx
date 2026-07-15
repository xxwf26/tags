import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { GalleryPage } from './pages/GalleryPage';
import { ArtistsPage } from './pages/ArtistsPage';
import { ArtistPage } from './pages/ArtistPage';
import { DiscoverPage } from './pages/DiscoverPage';
import { ConfigPage } from './pages/ConfigPage';
import { AdminPage } from './pages/AdminPage';
import { SearchPage } from './pages/SearchPage';
import { EntryDialog } from './components/EntryDialog';
import { ImageSearchDialog } from './components/ImageSearchDialog';
import { BackToTop } from './components/BackToTop';
import { useState } from 'react';

const queryClient = new QueryClient();

function NavBar({ kw, setKw }: { kw: string; setKw: (s: string) => void }) {
  const loc = useLocation();
  const back = loc.pathname.startsWith('/artist/');
  const [entry, setEntry] = useState(false);
  const [imgSearch, setImgSearch] = useState(false);
  return (
    <>
      <header className="fixed top-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-b border-stone-100">
        <div className="max-w-[1600px] mx-auto px-3 md:px-6 h-14 flex items-center gap-2 md:gap-3">
          {back && <Link to="/" className="text-stone-500 text-xl w-8 shrink-0">‹</Link>}
          <Link to="/" className="flex items-center gap-1.5 font-bold text-xhs text-base md:text-lg shrink-0">
            <span className="bg-xhs text-white w-7 h-7 rounded-lg flex items-center justify-center text-sm">画</span><span className="hidden sm:inline">画风库</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm shrink-0">
            <Link to="/" className={`px-2 md:px-2.5 py-1 rounded-full ${loc.pathname === '/' ? 'text-xhs font-medium' : 'text-stone-500'}`}>画师库</Link>
            <Link to="/gallery" className={`px-2 md:px-2.5 py-1 rounded-full ${loc.pathname === '/gallery' ? 'text-xhs font-medium' : 'text-stone-500'}`}>画廊</Link>
            <Link to="/discover" className={`px-2 md:px-2.5 py-1 rounded-full ${loc.pathname === '/discover' ? 'text-xhs font-medium' : 'text-stone-500'}`}>发现</Link>
            <Link to="/search" className={`px-2 md:px-2.5 py-1 rounded-full ${loc.pathname === '/search' ? 'text-xhs font-medium' : 'text-stone-500'}`}>寻源</Link>
            <Link to="/config" className={`px-2 md:px-2.5 py-1 rounded-full ${loc.pathname === '/config' ? 'text-xhs font-medium' : 'text-stone-500'}`}>配置</Link>
            <Link to="/admin" className={`px-2 md:px-2.5 py-1 rounded-full ${loc.pathname === '/admin' ? 'text-xhs font-medium' : 'text-stone-500'}`}>管理</Link>
          </nav>
          <div className="flex-1 max-w-md mx-auto hidden md:block">
            <input value={kw} onChange={e => setKw(e.target.value)} placeholder="🔍 搜画风 / 画师 / 标题，如「油画」"
              className="w-full bg-stone-100 rounded-full px-4 py-1.5 text-sm outline-none focus:bg-stone-200/60" />
          </div>
          <button onClick={() => setImgSearch(true)} className="text-sm text-stone-600 border border-stone-200 px-2.5 md:px-3 py-1.5 rounded-full hover:bg-stone-50 shrink-0">📷<span className="hidden sm:inline ml-1">以图搜图</span></button>
          <button onClick={() => setEntry(true)} className="text-sm bg-xhs text-white px-3 md:px-3.5 py-1.5 rounded-full font-medium shrink-0">＋<span className="hidden sm:inline ml-0.5">录作品</span></button>
        </div>
      </header>
      {entry && <EntryDialog onClose={() => setEntry(false)} />}
      {imgSearch && <ImageSearchDialog onClose={() => setImgSearch(false)} />}
    </>
  );
}

export default function App() {
  const [kw, setKw] = useState('');
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <NavBar kw={kw} setKw={setKw} />
        <main className="pt-14">
          <Routes>
            <Route path="/" element={<ArtistsPage />} />
            <Route path="/gallery" element={<GalleryPage kw={kw} setKw={setKw} />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/admin" element={<AdminPage />} />
          <Route path="/search" element={<SearchPage />} />
            <Route path="/artist/:id" element={<ArtistPage />} />
          </Routes>
        </main>
        <BackToTop />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
