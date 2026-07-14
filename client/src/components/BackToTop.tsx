import { useEffect, useState } from 'react';

// 全局「回到顶部」悬浮按钮：滚动超过 400px 时出现
export function BackToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 400);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      title="回到顶部"
      className="fixed bottom-6 right-6 z-40 w-11 h-11 rounded-full bg-white/90 backdrop-blur border border-stone-200 shadow-lg text-stone-600 text-lg flex items-center justify-center hover:bg-xhs hover:text-white hover:border-xhs transition-colors"
    >↑</button>
  );
}
