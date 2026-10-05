import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Interview } from "@/components/ui/interview";
import "./index.css";
import { useState } from "react";

export function App() {
  const [isInterviewStarted, setIsInterviewStarted] = useState(false);

  if (isInterviewStarted) {
    return <Interview />;
  }

  return (
    <div className="h-screen w-screen flex justify-center items-center">
      <div className="flex flex-col gap-4 w-full max-w-sm px-4">
        <h1 className="text-2xl font-bold text-center mb-4">Interview kickstart</h1>
        <Input placeholder="Name" />
        <Input placeholder="Email" type="email" />
        <Button onClick={() => setIsInterviewStarted(true)}>Start Interview</Button>
      </div>
    </div>
  );
}

export default App;
