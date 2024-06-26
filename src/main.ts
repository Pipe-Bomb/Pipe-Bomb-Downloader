import DotEnv from "dotenv";
import Axios, { AxiosResponse } from "axios";
import PipeBomb from "pipebomb.js";
import * as FS from "fs";
import Sanitize from "sanitize-filename";
import Ffmpeg from "ffmpeg-static";
import { exec } from "child_process";
import * as ID3 from "node-id3";
import Playlist from "pipebomb.js/dist/collection/Playlist";
import Track from "pipebomb.js/dist/music/Track";
DotEnv.config();

if (!Ffmpeg) {
    throw new Error("Failed to locate FFMPEG");
}

const serverAddress = process.env.PB_SERVER;
if (!serverAddress) {
    throw new Error(`env "PB_SERVER" not provided.`);
}

const privateKey = process.env.PB_KEY;
if (!privateKey) {
    throw new Error(`env "PB_TOKEN" not provided.`);
}

console.log("Authenticating...");
const api = new PipeBomb(serverAddress, {
    privateKey
});
api.authenticate("unused", {
    privateKey,
    createIfMissing: false
}).then(async jwt => {
    api.context.setToken(jwt);

    FS.rmSync("tmp", {
        recursive: true,
        force: true
    });
    FS.mkdirSync("tmp", {
        recursive: true
    });

    console.log("Locating playlists...");
    const playlists = await api.v1.getPlaylists();
    console.log(`Located ${playlists.length} playlists.`);

    for (let playlist of playlists) {
        try {
            await downloadPlaylist(playlist);
        } catch (e) {
            console.error(e);
        }
    }
    console.log("Cleaning up...");
    FS.rmSync("tmp", {
        recursive: true,
        force: true
    });
    console.log("Finished!");
    process.exit();
});

function downloadTrack(track: Track, path: string) {
    return new Promise<void>(async (resolve, reject) => {
        try {
            if (FS.existsSync(path)) {
                return resolve();
            }

            if (!track.getMetadata()) {
                await track.loadMetadata();
            }
            const metadata = track.getMetadata();

            const audioResponse: AxiosResponse<Buffer, any> = await Axios.get(track.getAudioUrl(), {
                responseType: "arraybuffer"
            });

            const audioType: string = audioResponse.headers["content-type"] || "";

            if (!audioType.startsWith("audio/")) {
                throw new Error(`Mime type "${audioType}" not supported.`);
            }

            const extension = {
                "webm": "webm",
                "mpeg": "mp3"
            }[audioType.substring(6)];

            if (!extension) {
                throw new Error(`Mime type "${audioType}" not supported.`);
            }

            const tempFile = `tmp/${track.trackID}.${extension}`;

            FS.writeFile(tempFile, audioResponse.data, {}, async (e) => {
                if (e) {
                    return reject(e);
                }

                const command = `${Ffmpeg} -i "${tempFile}" "${path}"`;

                let image: Buffer | null;
                try {
                    const imageResponse: AxiosResponse<Buffer, any> = await Axios.get(track.getThumbnailUrl(), {
                        responseType: "arraybuffer"
                    });
                    if (imageResponse.status == 200) {
                        image = imageResponse.data;
                    }
                } catch {}

                exec(command, (error) => {
                    if (error) {
                        reject(error);
                    } else {
                        const state = ID3.write({ // todo: lyrics support
                            title: metadata.title,
                            artist: metadata.artists.join(", "),
                            image: image ? {
                                mime: "image/jpeg",
                                type: {
                                    id: 3,
                                    name: "Cover"
                                },
                                description: "From Pipe Bomb",
                                imageBuffer: image
                            } : undefined
                        }, path);

                        if (state === true) {
                            resolve();
                        } else {
                            reject(state);
                        }
                    }
                });
            });
        } catch (e) {
            reject(e);
        }
    });
}

function downloadPlaylist(playlist: Playlist) {
    return new Promise<void>(async (resolve, reject) => {
        try {
            const dir = `download/${playlist.owner.username}/${playlist.collectionID} - ${Sanitize(playlist.getName())}`;
            FS.mkdirSync(dir, {
                recursive: true
            });
    
            const trackList = await playlist.getTrackList();
    
            const total = trackList.length;
            let completed = 0;
    
            async function dl() {
                const track = trackList.shift();
                if (!track) {
                    if (completed >= total) {
                        console.log(`Finished downloading playlist "${playlist.getName()}"`);
                        resolve();
                    }
                } else {
                    try {
                        await downloadTrack(track, `${dir}/${track.trackID}.mp3`);
                    } catch (e) {
                        console.error(`Failed to download "${track.trackID}".`);
                    }
                    completed++;
                    console.log(`${playlist.getName()} (${completed}/${total})`);
                    dl();
                }
            }
    
            const THREADS = 15;
            for (let i = 0; i < THREADS; i++) {
                dl();
            }
        } catch (e) {
            reject(e);
        }
    });
}