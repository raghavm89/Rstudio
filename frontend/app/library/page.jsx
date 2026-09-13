import Soon from '../../components/Soon';

export default function Page() {
  return (
    <>
      <div className="topbar"><div className="crumb"><b>Library</b></div></div>
      <div className="page">
        <Soon
          title="No photos or clips yet"
          what="Everything they have generated, filterable by shoot and re-usable. Photos that passed the likeness check, clips, voice takes, and the ones that were cut — with the reason why."
          blocked={null}
          next={{ href: "/avatars", label: "make their first photos" }}
        />
      </div>
    </>
  );
}
