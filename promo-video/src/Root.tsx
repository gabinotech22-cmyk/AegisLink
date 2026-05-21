import "./index.css";
import { Composition } from "remotion";
import { MyComposition } from "./Composition";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AegisLinkPromo"
        component={MyComposition}
        durationInFrames={900}
        fps={30}
        width={1280}
        height={720}
      />
    </>
  );
};


