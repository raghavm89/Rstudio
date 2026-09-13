import Soon from '../../components/Soon';

export default function Page() {
  return (
    <>
      <div className="topbar"><div className="crumb"><b>Insights</b></div></div>
      <div className="page">
        <Soon
          title="Nothing to measure yet"
          what="Which photos and captions actually worked, fed back into what to shoot next. This is the loop that makes the product worth paying for — generation alone is a commodity."
          blocked={"Publishing. There is nothing to measure until posts exist."}
          next={{ href: "/publish", label: "connect publishing" }}
        />
      </div>
    </>
  );
}
