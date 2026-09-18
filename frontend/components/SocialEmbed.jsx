'use client';

import { useEffect } from 'react';

/**
 * One embedded post — Instagram (their embed.js turns the blockquote into the
 * real card) or YouTube (a plain iframe; Shorts are just vertical videos).
 *
 * Instagram's script is loaded once per page and re-run after every mount, so
 * posts added later in the list render too. Until it runs, the blockquote shows
 * a plain link — a working fallback, not a blank.
 */
export default function SocialEmbed({ post }) {
  useEffect(() => {
    if (post.kind !== 'instagram') return;
    const run = () => window.instgrm?.Embeds?.process?.();
    if (window.instgrm) { run(); return; }
    let s = document.getElementById('ig-embed-js');
    if (!s) {
      s = document.createElement('script');
      s.id = 'ig-embed-js';
      s.async = true;
      s.src = 'https://www.instagram.com/embed.js';
      document.body.appendChild(s);
    }
    s.addEventListener('load', run);
    return () => s.removeEventListener('load', run);
  }, [post]);

  if (post.kind === 'youtube') {
    return (
      <div className="pl-embed yt">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${post.id}?rel=0&modestbranding=1`}
          title="YouTube video"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <div className="pl-embed ig">
      <blockquote
        className="instagram-media"
        data-instgrm-permalink={post.permalink}
        data-instgrm-version="14"
        style={{ background: '#fff', border: 0, margin: 0, padding: 0, width: '100%', minWidth: 0 }}
      >
        <a href={post.permalink} target="_blank" rel="noreferrer">View this post on Instagram</a>
      </blockquote>
    </div>
  );
}
