import { usestate } from "react";
import { button } from "../components/ui/button";
import { Input } from "../components/ui/input";

export function Form() {
    const [github, setGithub] = useState("");
    const [linkedin, setLinkedin] = useState("");

    return (
        <form className="flex flex-col gap-4">
            <Input type="text" placeholder="GitHub" value={github} onChange={(e) => setGithub(e.target.value)} />
            <Input type="text" placeholder="LinkedIn" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />
            <button type="submit">Submit</button>
        </form>
    )
} 