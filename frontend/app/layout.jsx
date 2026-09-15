import './globals.css';
import Shell from '../components/Shell';
import { AuthProvider } from '../components/AuthProvider';

export const metadata = {
  title: 'ZoQ — AI creators, made for India',
  description: 'Your AI creator, posting for you. The same face, every shot.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500&family=Bodoni+Moda:ital,wght@0,400;0,500;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
          {/* AuthProvider wraps Shell, not the other way round: the shell's
              sidebar shows the signed-in workspace and usage, so it must not
              render before we know whether anyone is signed in. */}
          <AuthProvider><Shell>{children}</Shell></AuthProvider>
        </body>
    </html>
  );
}
