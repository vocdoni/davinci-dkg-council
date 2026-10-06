/**
 * Council ABI: the full read/write surface of the deployment, generated
 * verbatim from the compiled interface and contract:
 * - functions and events: solidity/out/ICouncil.sol/ICouncil.json
 * - errors: solidity/out/CouncilManager.sol/CouncilManager.json
 *
 * The contracts are split for EIP-170 (CouncilManager + CouncilViews
 * behind the manager's fallback, same address, shared storage), so every
 * call — views included — goes to the manager address. Regenerate after any
 * contract change: `forge build` in solidity, then rebuild this
 * array. The `abi-equals` test in tests/unit-io.test.ts asserts this file
 * matches the compiled artifacts exactly.
 */

import type { Abi } from 'viem';

export const COUNCIL_MANAGER_ABI = [
  {
    "type": "function",
    "name": "abort",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "addInvites",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct AddInvites",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "firstInviteId",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "inviteKeys",
            "type": "address[]",
            "internalType": "address[]"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "orgSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "allowAdapter",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct AllowAdapter",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "adapter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "orgSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "authorizeCreator",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct AuthorizeCreator",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "creator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "orgSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "bindProcess",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "processId",
        "type": "bytes31",
        "internalType": "bytes31"
      },
      {
        "name": "creator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "pkX",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "pkY",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "ceremonyIdFor",
    "inputs": [
      {
        "name": "organizer",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "nonce",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "circuitReleaseId",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "closeRegistration",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct CloseRegistration",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "participantCount",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "orgSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "combine",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "memberSet",
        "type": "uint8[]",
        "internalType": "uint8[]"
      },
      {
        "name": "fieldIndexes",
        "type": "uint8[]",
        "internalType": "uint8[]"
      },
      {
        "name": "plaintexts",
        "type": "uint64[]",
        "internalType": "uint64[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createCeremony",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct CreateCeremony",
        "components": [
          {
            "name": "organizer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "nonce",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "threshold",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "registrationDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "dealingDuration",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "inviteKeys",
            "type": "address[]",
            "internalType": "address[]"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "orgSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "deal",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct Deal",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "dealerIndex",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "payloadHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "sig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "C",
        "type": "uint256[2][16]",
        "internalType": "uint256[2][16]"
      },
      {
        "name": "E",
        "type": "uint256[2]",
        "internalType": "uint256[2]"
      },
      {
        "name": "maskedShares",
        "type": "uint256[16]",
        "internalType": "uint256[16]"
      },
      {
        "name": "pA",
        "type": "uint256[2]",
        "internalType": "uint256[2]"
      },
      {
        "name": "pB",
        "type": "uint256[2][2]",
        "internalType": "uint256[2][2]"
      },
      {
        "name": "pC",
        "type": "uint256[2]",
        "internalType": "uint256[2]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "dealVerifier",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "finalize",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getAggregates",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [
      {
        "name": "A",
        "type": "uint256[2][16]",
        "internalType": "uint256[2][16]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getBinding",
    "inputs": [
      {
        "name": "adapter",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "processId",
        "type": "bytes31",
        "internalType": "bytes31"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "requested",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getCeremony",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct CeremonyView",
        "components": [
          {
            "name": "phase",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "organizer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "threshold",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "n",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "registrationDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "dealingDeadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "joinedCount",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "dealtCount",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "rosterHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "ctx",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "inviteCount",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "consumedInvites",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "qualBitmap",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "pkX",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pkY",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getDealing",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "dealerIndex",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "C",
        "type": "uint256[2][16]",
        "internalType": "uint256[2][16]"
      },
      {
        "name": "E",
        "type": "uint256[2]",
        "internalType": "uint256[2]"
      },
      {
        "name": "maskedShares",
        "type": "uint256[16]",
        "internalType": "uint256[16]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getInvite",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "inviteId",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "key",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "consumed",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getMemberKey",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "index",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "x",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "y",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPartial",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "D",
        "type": "uint256[2][16]",
        "internalType": "uint256[2][16]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getParticipant",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "index",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "outputs": [
      {
        "name": "auth",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "pkX",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "pkY",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "dealt",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPlaintexts",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "ready",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "values",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getPublicKey",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [
      {
        "name": "x",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "y",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getQual",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [
      {
        "name": "bitmap",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRequest",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "fieldCount",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "completedBitmap",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "partialBitmap",
        "type": "uint16",
        "internalType": "uint16"
      },
      {
        "name": "cts",
        "type": "uint256[4][]",
        "internalType": "uint256[4][]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRequestCount",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRequestIds",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRequestIdsPage",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "offset",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "limit",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32[]",
        "internalType": "bytes32[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getRequestOrigin",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "adapter",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "processId",
        "type": "bytes31",
        "internalType": "bytes31"
      },
      {
        "name": "creator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isAdapterAllowed",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "adapter",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isCreatorAuthorized",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "creator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "join",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct Join",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "participant",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "inviteId",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "pkX",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pkY",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "popAx",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "popAy",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "popZ",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "participantSig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "inv",
        "type": "tuple",
        "internalType": "struct Invite",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "inviteId",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "participant",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "pkX",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "pkY",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "inviteSig",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "partialVerifier",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "participantIndexOf",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "auth",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "submitPartial",
    "inputs": [
      {
        "name": "a",
        "type": "tuple",
        "internalType": "struct Partial",
        "components": [
          {
            "name": "ceremonyId",
            "type": "bytes12",
            "internalType": "bytes12"
          },
          {
            "name": "requestId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "participantIndex",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "payloadHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "sig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "D",
        "type": "uint256[2][16]",
        "internalType": "uint256[2][16]"
      },
      {
        "name": "pA",
        "type": "uint256[2]",
        "internalType": "uint256[2]"
      },
      {
        "name": "pB",
        "type": "uint256[2][2]",
        "internalType": "uint256[2][2]"
      },
      {
        "name": "pC",
        "type": "uint256[2]",
        "internalType": "uint256[2]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "submitRequest",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "internalType": "bytes12"
      },
      {
        "name": "processId",
        "type": "bytes31",
        "internalType": "bytes31"
      },
      {
        "name": "cts",
        "type": "uint256[4][]",
        "internalType": "uint256[4][]"
      }
    ],
    "outputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "views",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "AdapterAllowed",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "adapter",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CeremonyAborted",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "phaseAtAbort",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CeremonyCreated",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "organizer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "threshold",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "registrationDeadline",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "dealingDuration",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CeremonyFinalized",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "qualBitmap",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "pkX",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "pkY",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "CreatorAuthorized",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DealingAccepted",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "dealerIndex",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FieldsCombined",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "fieldIndexes",
        "type": "uint8[]",
        "indexed": false,
        "internalType": "uint8[]"
      },
      {
        "name": "plaintexts",
        "type": "uint64[]",
        "indexed": false,
        "internalType": "uint64[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "InvitesAdded",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "firstInviteId",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "count",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "PartialAccepted",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ParticipantJoined",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "index",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "auth",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "inviteId",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ProcessBound",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "adapter",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "processId",
        "type": "bytes31",
        "indexed": false,
        "internalType": "bytes31"
      },
      {
        "name": "requestId",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RegistrationClosed",
    "inputs": [
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "n",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "rosterHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "dealingDeadline",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RequestCompleted",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RequestSubmitted",
    "inputs": [
      {
        "name": "requestId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "cid",
        "type": "bytes12",
        "indexed": true,
        "internalType": "bytes12"
      },
      {
        "name": "fieldCount",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AbortConditionNotMet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyBound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyDealt",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyListed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyPartial",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyRequested",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadDuration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadFieldCount",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadFieldIndexes",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadInviteIndex",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadMemberSet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadPadding",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadPoP",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadThreshold",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowThreshold",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CeremonyExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CombineCheckFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DuplicateInvite",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DuplicateKey",
    "inputs": []
  },
  {
    "type": "error",
    "name": "DuplicateParticipant",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Expired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FieldCompleted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FinalizeConditionNotMet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidPoint",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InviteConsumed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MissingPartial",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoInvites",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonCanonical",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAllowedAdapter",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAuthorizedCreator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotInSubgroup",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotQualified",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PayloadMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PlaintextTooLarge",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ProofInvalid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RosterFull",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RosterMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyInvites",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownBinding",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownCeremony",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownInvite",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownRequest",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongPhase",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const satisfies Abi;
