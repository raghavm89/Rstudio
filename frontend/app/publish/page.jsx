import Soon from '../../components/Soon';

export default function Page() {
  return (
    <>
      <div className="topbar"><div className="crumb"><b>Publish</b></div></div>
      <div className="page">
        <Soon
          title="Publishing is not connected"
          what="Post straight to Instagram and YouTube on a schedule, with the AI disclosure line attached. Also the comment-to-DM rules: someone comments a keyword, they get the message you wrote."
          blocked={"Meta app review, YouTube compliance audit and Business Verification. All three take weeks of calendar time, so they are worth starting long before the code is ready."}
          next={null}
        />
      </div>
    </>
  );
}
