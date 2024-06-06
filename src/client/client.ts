// Agent <-> Server
import { io, Socket } from 'socket.io-client';
// Agent <-> Agent
import { Peer, DataConnection, MediaConnection } from 'peerjs';

import {
    EPacketType,
    C_AGENT_Heartbeat_Packet,
    C_WORLD_AgentList_Packet,
    C_AUDIO_Metadata_Packet,
} from '../routes/meta';

// FIXME: This should be defined in config.
const TEMP_ICE_SERVERS = [
    {
        urls: ['stun:stun.l.google.com:19302'],
    },
];

export namespace Client {
    let socket: Socket | null = null;
    let TEMP_agentId: string | null = null;
    // FIXME: This is temp, avatars shouldn't exist, all avatars should simply be entities.
    let TEMP_position: {
        x: number;
        y: number;
        z: number;
    } | null = null;
    let TEMP_orientation: {
        x: number;
        y: number;
        z: number;
    } | null = null;

    export const TEMP_updateMetadataLocally = (metadata: {
        position: { x: number; y: number; z: number };
        orientation: { x: number; y: number; z: number };
    }) => {
        TEMP_position = metadata.position;
        TEMP_orientation = metadata.orientation;

        Agent.sendHeartbeatToAgents();
    };

    export const worldConnected = () => socket?.connected ?? false;

    export namespace Setup {
        let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

        export const InitializeWorldModule = (data: {
            host: string;
            port: number;
            agentId: string;
        }) => {
            TEMP_agentId = data.agentId;

            if (socket && socket.connected) {
                console.log('Already connected to the server.');
                return;
            }

            if (socket) {
                socket.removeAllListeners();
                socket.close();
                console.log('Closed existing socket.');
            }

            socket = io(`${data.host}:${data.port}`, {});

            Agent.InitializeAgentModule(data.agentId);

            // Listening to events
            socket.on('connect', () => {
                console.log(`Connected to server at ${data.host}:${data.port}`);

                heartbeatInterval = setInterval(() => {
                    sendHeartbeatPacket();
                }, 1000); // TODO: Use a constant or configuration variable for the interval duration
            });

            socket.on('disconnect', () => {
                socket?.removeAllListeners();
                clearInterval(
                    heartbeatInterval as ReturnType<typeof setInterval>,
                );
                console.log('Disconnected from server');
            });

            socket.on('connect_error', (error) => {
                console.error('Connection error:', error);
                // Handle the connection error, e.g., retry connection or notify the user
            });
        };

        const sendHeartbeatPacket = () => {
            socket?.emit(
                EPacketType.AGENT_Heartbeat,
                new C_AGENT_Heartbeat_Packet({
                    senderId: TEMP_agentId,
                }),
            );
        };
    }

    export namespace Agent {
        const AGENT_LOG_PREFIX = '[AGENT]';
        let peer: Peer | null = null;

        export const hasAgentsConnected = () =>
            Object.keys(agentConnections).length > 0;

        export const agentConnections: {
            [key: string]: {
                dataConnection: DataConnection | null;
                media: {
                    connection: MediaConnection | null;
                    metadata: C_AUDIO_Metadata_Packet | null;
                };
            };
        } = {};

        export const InitializeAgentModule = (agentId: string) => {
            Media.InitializeMediaModule();

            peer = new Peer(agentId, {
                host: '/',
                path: '/peerjs',
                port: 3000,
            });

            peer.on('connection', (conn: DataConnection) => {
                console.log(`Incoming data connection from ${conn.peer}`);
                if (!agentConnections[conn.peer]) {
                    createAgent(conn.peer);
                }
                handleDataConnection(conn);
            });

            peer.on('call', (call: MediaConnection) => {
                console.log(`Incoming media connection from ${call.peer}`);
                if (!agentConnections[call.peer]) {
                    createAgent(call.peer);
                }
                handleMediaConnection(call);
            });

            socket?.on(EPacketType.WORLD_AgentList, handleAgentListUpdate);
        };

        const handleDataConnection = (conn: DataConnection) => {
            const remoteAgentId = conn.peer;
            console.log(`Received data connection from agent ${remoteAgentId}`);

            agentConnections[remoteAgentId].dataConnection = conn;

            conn.on('data', (data) => {
                // console.log(`Received data from agent ${remoteAgentId}:`, data);
                // if (data instanceof C_AUDIO_Metadata_Packet) {
                //     if (agentConnections[remoteAgentId].media.connection) {
                //         agentConnections[remoteAgentId].media.metadata = data;
                //     }
                // }
            });

            conn.on('close', () => {
                console.log(
                    `Data connection closed with agent ${remoteAgentId}`,
                );
                removeDataConnection(remoteAgentId);
            });
        };

        const removeDataConnection = (agentId: string) => {
            if (agentConnections[agentId].dataConnection) {
                agentConnections[agentId].dataConnection.close();
                agentConnections[agentId].dataConnection = null;
            }
        };

        const handleMediaConnection = (call: MediaConnection) => {
            const remoteAgentId = call.peer;
            console.log(
                `${AGENT_LOG_PREFIX} Received a media call from:`,
                remoteAgentId,
            );

            const acceptedCall = acceptMediaCall(call);

            if (acceptedCall) {
                setTimeout(() => {
                    void Media.testAudioConnection(remoteAgentId);
                }, 2500);

                call.on('stream', (remoteStream) => {
                    console.info(
                        `${AGENT_LOG_PREFIX} Received remote stream from [${remoteAgentId}]`,
                        remoteStream,
                    );
                    void Media.handleIncomingStream({
                        stream: remoteStream,
                        agentId: remoteAgentId,
                    });
                });

                call.on('close', () => {
                    console.log('Media call closed');
                    removeMediaConnection(remoteAgentId);
                });

                call.on('error', (error) => {
                    console.error('Media call error:', error);
                });
            } else {
                console.info(
                    `${AGENT_LOG_PREFIX} Media call rejected from [${remoteAgentId}]`,
                );
            }
        };

        const removeMediaConnection = (agentId: string) => {
            if (agentConnections[agentId].media.connection) {
                agentConnections[agentId].media.connection.close();
                agentConnections[agentId].media.connection = null;
            }
        };

        const handleAgentListUpdate = (message: C_WORLD_AgentList_Packet) => {
            // console.log('Received agent list update');
            const { agentList } = message;
            // console.log('Updated agent list:', agentList);

            // Remove connections for agents no longer present
            Object.keys(agentConnections).forEach((agentId) => {
                if (!agentList.includes(agentId)) {
                    removeAgent(agentId);
                }
            });

            // Establish new connections for new agents
            agentList.forEach((agentId) => {
                if (agentId !== peer?.id) {
                    const agentConnection = agentConnections[agentId];

                    if (!agentConnection) {
                        createAgent(agentId);
                    }

                    if (!agentConnection.dataConnection?.open) {
                        makeDataConnection(agentId);
                    }

                    if (!agentConnection.media.connection?.open) {
                        makeMediaConnection(agentId);
                    }
                }
            });
        };

        const createAgent = (agentId: string) => {
            agentConnections[agentId] = {
                dataConnection: null,
                media: {
                    connection: null,
                    metadata: null,
                },
            };
        };

        const removeAgent = (agentId: string) => {
            if (agentConnections[agentId]) {
                agentConnections[agentId].dataConnection?.close();
                agentConnections[agentId].media.connection?.close();
                delete agentConnections[agentId];
            }
        };

        const acceptMediaCall = (mediaCall: MediaConnection): boolean => {
            const localStream = Media.getLocalStream({ kind: 'audio' });

            if (!localStream) {
                console.error(
                    'No local audio stream available to answer the call.',
                );
                return false;
            }

            if (localStream.getAudioTracks().length === 0) {
                console.error('Local audio stream has no audio tracks.');
                return false;
            }

            mediaCall.answer(localStream);

            if (agentConnections[mediaCall.peer]) {
                agentConnections[mediaCall.peer].media.connection?.close();
                agentConnections[mediaCall.peer].media.connection = mediaCall;
            } else {
                createAgent(mediaCall.peer);
                agentConnections[mediaCall.peer].media.connection = mediaCall;
            }

            return true;
        };

        const makeDataConnection = (agentId: string) => {
            const agentConnection = agentConnections[agentId];

            if (peer && agentConnection) {
                const dataConn = peer.connect(agentId);
                if (!dataConn) {
                    console.error(
                        `${AGENT_LOG_PREFIX} Failed to establish data connection with agent ${agentId}`,
                    );
                    return;
                }

                agentConnection.dataConnection = dataConn;

                dataConn.on('open', () => {
                    console.log(`Data connection opened with agent ${agentId}`);
                });

                dataConn.on('close', () => {
                    console.log(`Data connection closed with agent ${agentId}`);
                    removeDataConnection(agentId);
                });
            }
        };

        const makeMediaConnection = (agentId: string) => {
            const agentConnection = agentConnections[agentId];
            const localStream = Media.getLocalStream({ kind: 'audio' });

            if (!localStream) {
                console.error(
                    'No local audio stream available to initiate the call.',
                );
                return;
            }

            if (localStream.getAudioTracks().length === 0) {
                console.error('Local audio stream has no audio tracks.');
                return;
            }

            if (peer && agentConnection) {
                const mediaConn = peer.call(agentId, localStream);
                if (!mediaConn) {
                    console.error(
                        `${AGENT_LOG_PREFIX} Failed to establish media connection with agent ${agentId}`,
                    );
                    return;
                }

                agentConnection.media.connection = mediaConn;

                console.log(
                    `${AGENT_LOG_PREFIX} Establishing media connection with agent ${agentId}`,
                );

                mediaConn.on('stream', (remoteStream) => {
                    console.log(`Received remote stream from agent ${agentId}`);
                    void Media.handleIncomingStream({
                        stream: remoteStream,
                        agentId,
                    });

                    // Send a test audio message after a short delay
                    setTimeout(() => {
                        void Media.testAudioConnection(agentId);
                    }, 2500);
                });

                mediaConn.on('close', () => {
                    console.log(
                        `Media connection closed with agent ${agentId}`,
                    );
                    removeMediaConnection(agentId);
                });

                mediaConn.on('error', (error) => {
                    console.error(
                        `Media connection error with agent ${agentId}:`,
                        error,
                    );
                });
            } else {
                console.error(
                    `${AGENT_LOG_PREFIX} Failed to establish media connection with agent ${agentId}`,
                );
            }
        };

        export const sendHeartbeatToAgents = () => {
            // console.info(
            //     'TEMP: Are my audio tracks muted?',
            //     Media.getLocalStream({ kind: 'audio' }),
            // );

            Object.entries(agentConnections).forEach(
                ([agentId, connection]) => {
                    if (
                        connection.dataConnection &&
                        connection.dataConnection.open &&
                        TEMP_position &&
                        TEMP_orientation
                    ) {
                        const packet = new C_AUDIO_Metadata_Packet({
                            senderId: TEMP_agentId,
                            audioPosition: TEMP_position,
                            audioOrientation: TEMP_orientation,
                        });
                        void connection.dataConnection.send(packet);
                        // console.log(
                        //     `${AGENT_LOG_PREFIX} Sent metadata to agent ${agentId}, audio track:`,
                        //     connection.media.connection,
                        // );
                        console.info(
                            'mediaConnection stats',
                            connection.media.connection?.localStream,
                            connection.media.connection?.remoteStream,
                        );
                    } else {
                        console.warn(
                            `${AGENT_LOG_PREFIX} Unable to send metadata to agent ${agentId}. Connection status:`,
                            connection,
                            'Position:',
                            TEMP_position,
                            'Orientation:',
                            TEMP_orientation,
                        );
                    }
                },
            );
        };

        export namespace Media {
            const MEDIA_LOG_PREFIX = '[MEDIA]';

            let audioContext: AudioContext | null = null;
            // eslint-disable-next-line prefer-const
            let localAudioStream: MediaStream | null = null;
            const localVideoStream: MediaStream | null = null;

            export const InitializeMediaModule = () => {
                audioContext = new AudioContext();
            };

            export const testAudioConnection = (
                agentId: string,
            ): Promise<void> => {
                return new Promise((resolve, reject) => {
                    const connection =
                        agentConnections[agentId]?.media.connection;
                    const connectionStatus = connection?.open;
                    const audioContextStatus = audioContext?.state;

                    if (
                        connectionStatus &&
                        audioContext &&
                        audioContextStatus === 'running'
                    ) {
                        const oscillator = audioContext.createOscillator();
                        oscillator.type = 'sine';
                        oscillator.frequency.setValueAtTime(
                            440,
                            audioContext.currentTime,
                        );

                        const destination =
                            audioContext.createMediaStreamDestination();
                        oscillator.connect(destination);
                        oscillator.start();

                        const testStream = destination.stream;
                        const senders = connection.peerConnection.getSenders();
                        if (senders.length === 0) {
                            console.error(
                                `${MEDIA_LOG_PREFIX} No senders available in peer connection.`,
                            );
                            reject('No senders available in peer connection.');
                            return;
                        }

                        Promise.all(
                            senders.map((sender) => {
                                if (
                                    sender.track &&
                                    sender.track.kind === 'audio'
                                ) {
                                    return sender.replaceTrack(
                                        testStream.getAudioTracks()[0],
                                    );
                                }
                                return Promise.resolve();
                            }),
                        )
                            .then(() => {
                                setTimeout(() => {
                                    oscillator.stop();
                                    oscillator.disconnect();
                                    console.log(
                                        `${MEDIA_LOG_PREFIX} Sent test audio to agent ${agentId}`,
                                    );
                                    resolve();
                                }, 1000);
                            })
                            .catch((error) => {
                                console.error(
                                    `${MEDIA_LOG_PREFIX} Error replacing track:`,
                                    error,
                                );
                                reject(error);
                            });
                    } else {
                        console.warn(
                            `${MEDIA_LOG_PREFIX} Failed to send test audio packet ${agentId}`,
                            connection,
                            audioContext,
                        );
                        reject('Connection or audio context not ready.');
                    }
                });
            };

            export const updateLocalStream = async (data: {
                newStream: MediaStream;
                kind: 'video' | 'audio';
            }) => {
                localAudioStream = data.newStream;

                // Connect the local stream to the audio context destination for echo
                if (audioContext && data.kind === 'audio') {
                    if (audioContext.state === 'suspended') {
                        await audioContext.resume();
                        console.log(
                            `${MEDIA_LOG_PREFIX} Resumed OUTGOING audio context.`,
                        );
                    }

                    // const audioSource = audioContext.createMediaStreamSource(
                    //     data.newStream,
                    // );
                    // audioSource.connect(audioContext.destination);
                    // console.log(
                    //     `${MEDIA_LOG_PREFIX} Connected local audio stream to audio context destination.`,
                    // );

                    const audioTracks = data.newStream.getAudioTracks();
                    if (audioTracks.length === 0) {
                        console.warn(
                            `${MEDIA_LOG_PREFIX} No audio tracks found in the stream.`,
                        );
                    } else {
                        audioTracks.forEach((track) => {
                            track.enabled = true;
                            console.log(
                                `${MEDIA_LOG_PREFIX} Audio track:`,
                                track,
                            );
                        });
                    }
                } else {
                    console.info(
                        `${MEDIA_LOG_PREFIX} No audio context available [${audioContext}] or kind is not audio [${data.kind}]`,
                    );
                }

                Object.values(Client.Agent.agentConnections).forEach(
                    (connection) => {
                        if (connection.media.connection) {
                            connection.media.connection.peerConnection
                                .getSenders()
                                .forEach(async (sender) => {
                                    if (
                                        sender.track &&
                                        sender.track.kind === data.kind
                                    ) {
                                        const newTrack =
                                            data.newStream.getAudioTracks()[0];
                                        if (newTrack) {
                                            await sender.replaceTrack(newTrack);
                                        }
                                    }

                                    console.log(
                                        `${MEDIA_LOG_PREFIX} Updated local audio stream for ${sender}.`,
                                    );
                                });
                        }
                    },
                );

                console.log(
                    `${MEDIA_LOG_PREFIX} Updated local audio stream for all media connections.`,
                );
            };

            export const getLocalStream = (data: {
                kind: 'video' | 'audio';
            }): MediaStream | null => {
                if (data.kind === 'video') {
                    return localVideoStream;
                }
                if (data.kind === 'audio') {
                    return localAudioStream;
                }
                return null;
            };

            // export const handleIncomingStream = async (data: {
            //     stream: MediaStream;
            //     agentId: string;
            // }) => {
            //     if (!audioContext) {
            //         console.error(
            //             `${MEDIA_LOG_PREFIX} No audio context available.`,
            //         );
            //         return;
            //     }

            //     if (audioContext.state === 'suspended') {
            //         await audioContext.resume();
            //         console.log(
            //             `${MEDIA_LOG_PREFIX} Resumed INCOMING audio context.`,
            //         );
            //     }

            //     const audioTracks = data.stream.getAudioTracks();
            //     console.info(
            //         `${MEDIA_LOG_PREFIX} Received ${audioTracks.length} audio tracks from agent ${data.agentId} for stream [${data.stream}]`,
            //     );

            //     if (audioTracks.length === 0) {
            //         console.warn(
            //             `${MEDIA_LOG_PREFIX} No audio tracks in the incoming stream from agent ${data.agentId}`,
            //         );
            //         return;
            //     }

            //     audioTracks.forEach((track) => {
            //         track.enabled = true;
            //         console.info(
            //             `${MEDIA_LOG_PREFIX} Incoming audio track:`,
            //             track,
            //         );
            //     });

            //     const audioSource = audioContext.createMediaStreamSource(
            //         data.stream,
            //     );
            //     const panner = createSpatialPanner(data.agentId);

            //     // Directly connect the audio source to the destination for echo
            //     audioSource.connect(audioContext.destination);

            //     // Connect the audio source to both the panner and the destination
            //     audioSource.connect(panner);
            //     panner.connect(audioContext.destination);

            //     console.log(
            //         `${MEDIA_LOG_PREFIX} Connected incoming audio stream from agent ${data.agentId}`,
            //     );

            //     // Log "on data received" for each audio track
            //     data.stream.getTracks().forEach((track) => {
            //         track.onunmute = () => {
            //             console.log(
            //                 `${MEDIA_LOG_PREFIX} on data received from agent ${data.agentId}`,
            //             );
            //         };
            //     });
            // };

            // export const handleIncomingStream = (data: {
            //     stream: MediaStream;
            //     agentId: string;
            // }) => {
            //     const audioElement = new Audio();
            //     audioElement.srcObject = data.stream;
            //     audioElement.autoplay = true; // Ensure the audio plays automatically
            //     audioElement.controls = true; // Optionally add controls for testing
            //     document.body.appendChild(audioElement); // Append to the body to make it visible for debugging

            //     console.log(
            //         `${MEDIA_LOG_PREFIX} Playing incoming stream via HTML audio element for agent ${data.agentId}`,
            //     );
            // };

            export const handleIncomingStream = (data: {
                stream: MediaStream;
                agentId: string;
            }) => {
                if (
                    !audioContext ||
                    !audioContext.destination ||
                    audioContext.state !== 'running'
                ) {
                    console.error(
                        `${MEDIA_LOG_PREFIX} No audio context available.`,
                    );
                    return;
                }

                // Create an Audio element for direct playback
                const audioElement = new Audio();
                audioElement.srcObject = data.stream;
                audioElement.pause();
                audioElement.autoplay = false; // Ensure the audio plays automatically

                // Optionally, you can append the audio element to the body to make it visible for debugging
                // document.body.appendChild(audioElement);

                // Use AudioContext for additional audio processing
                const audioSource = audioContext.createMediaStreamSource(
                    data.stream,
                );
                audioSource.connect(audioContext.destination);

                console.info(
                    `${MEDIA_LOG_PREFIX} Connected incoming audio stream from agent ${data.agentId} to both Audio element and AudioContext.`,
                );
            };
            const createSpatialPanner = (agentId: string) => {
                const panner = audioContext!.createPanner();
                panner.panningModel = 'HRTF';
                panner.distanceModel = 'inverse';
                panner.refDistance = 1;
                panner.maxDistance = 10000;
                panner.rolloffFactor = 1;
                panner.coneInnerAngle = 360;
                panner.coneOuterAngle = 0;
                panner.coneOuterGain = 0;

                updatePannerPosition(panner, agentId);

                return panner;
            };

            const updatePannerPosition = (
                panner: PannerNode,
                agentId: string,
            ) => {
                const agentMetadata = agentConnections[agentId]?.media.metadata;

                if (agentMetadata) {
                    const { audioPosition, audioOrientation } = agentMetadata;
                    if (audioPosition) {
                        panner.positionX.setValueAtTime(
                            audioPosition.x,
                            audioContext!.currentTime,
                        );
                        panner.positionY.setValueAtTime(
                            audioPosition.y,
                            audioContext!.currentTime,
                        );
                        panner.positionZ.setValueAtTime(
                            audioPosition.z,
                            audioContext!.currentTime,
                        );
                    }

                    if (audioOrientation) {
                        panner.orientationX.setValueAtTime(
                            audioOrientation.x,
                            audioContext!.currentTime,
                        );
                        panner.orientationY.setValueAtTime(
                            audioOrientation.y,
                            audioContext!.currentTime,
                        );
                        panner.orientationZ.setValueAtTime(
                            audioOrientation.z,
                            audioContext!.currentTime,
                        );
                    }
                } else {
                    console.warn(
                        `${MEDIA_LOG_PREFIX} No metadata available for agent ${agentId}`,
                    );
                }
            };
        }
    }
}
