import Soon from '../../components/Soon';

export default function Page() {
  return (
    <>
      <div className="topbar"><div className="crumb"><b>Shoots</b></div></div>
      <div className="page">
        <Soon
          title="Nothing shot yet"
          what="Every post and reel they have made, with the step each one is on. A shoot runs nine stages — prompt, photos, checking, motion, voice, assembly, caption — and this is where you watch them."
          blocked={null}
          next={{ href: "/avatars", label: "finish setting them up" }}
        />
      </div>
    </>
  );
}
