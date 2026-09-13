import Soon from '../../../../components/Soon';
import { Steps } from '../../../../components/Shell';

export default function Page({ params }) {
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Shoot</b></div>
        <Steps current="shoot" avatarId={params.id} />
      </div>
      <div className="page">
        <Soon
          title="Shoot"
          what="Pick where they are, what they are wearing, how close, where the light is and how they look — then one button. Nine stages run and a finished post comes out the other end."
          blocked={"A trained, calibrated model. Until the likeness check has baselines, every frame would be judged against a permissive floor."}
          next={{ href: `/avatars/${params.id}/face`, label: "find the face" }}
        />
      </div>
    </>
  );
}
