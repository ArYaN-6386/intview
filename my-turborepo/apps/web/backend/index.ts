import express from "express";
import axios from "axios";
import { z } from "zod";

const app = express();
app.use(express.json());

const preInterviewSchema = z.object({
    github: z.string().url(),
});

app.post("/api/v1/pre-interview", async (req, res) => {
    try {
        const validation = preInterviewSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: "Invalid request body. 'github' must be a valid URL." });
        }

        const { github } = validation.data;
        const cleanedUrl = github.endsWith("/") ? github.slice(0, -1) : github;
        const username = cleanedUrl.split("/").pop();

        if (!username) {
            return res.status(400).json({ error: "Could not extract username from GitHub URL." });
        }

        const response = await axios.get(`https://api.github.com/users/${username}`);
        const userData = response.data;

        return res.status(200).json({
            username: userData.login,
            bio: userData.bio,
            publicRepos: userData.public_repos,
        });
    } catch (error: any) {
        if (error.response && error.response.status === 404) {
            return res.status(404).json({ error: "GitHub user not found." });
        }
        console.error("System Error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(3001, () => {
    console.log("REST Server is running on port 3001");
});
