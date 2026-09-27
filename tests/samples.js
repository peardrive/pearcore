export const exampleFileList = {
    '/doc1.txt': {
        'hashA1': {
            peers: {
                'peerA': { timestamp: 1000, signature: 'sigA1' },
                'peerB': { timestamp: 1001, signature: 'sigB1' }
            }
        },
        'hashA2': {
            peers: {
                'peerC': { timestamp: 1002, signature: 'sigC2' },
                'peerD': { timestamp: 1003, signature: 'sigD2' }
            }
        }
    },

    '/doc2.pdf': {
        'hashB1': {
            peers: {
                'peerE': { timestamp: 2000, signature: 'sigE1' },
                'peerF': { timestamp: 2001, signature: 'sigF1' }
            }
        },
        'hashB2': {
            peers: {
                'peerG': { timestamp: 2002, signature: 'sigG2' },
                'peerH': { timestamp: 2003, signature: 'sigH2' }
            }
        }
    },

    '/doc3.zip': {
        'hashC1': {
            peers: {
                'peerI': { timestamp: 3000, signature: 'sigI1' },
                'peerJ': { timestamp: 3001, signature: 'sigJ1' }
            }
        },
        'hashC2': {
            peers: {
                'peerK': { timestamp: 3002, signature: 'sigK2' },
                'peerL': { timestamp: 3003, signature: 'sigL2' }
            }
        }
    }
};

export const exampleFileStack = [
    ['/doc1.txt', 'peerA', 1000, 'hashA1', 'sigA1'],
    ['/doc1.txt', 'peerB', 1001, 'hashA1', 'sigB1'],
    ['/doc1.txt', 'peerC', 1002, 'hashA2', 'sigC2'],
    ['/doc1.txt', 'peerD', 1003, 'hashA2', 'sigD2'],
    ['/doc2.pdf', 'peerE', 2000, 'hashB1', 'sigE1'],
    ['/doc2.pdf', 'peerF', 2001, 'hashB1', 'sigF1'],
    ['/doc2.pdf', 'peerG', 2002, 'hashB2', 'sigG2'],
    ['/doc2.pdf', 'peerH', 2003, 'hashB2', 'sigH2'],
    ['/doc3.zip', 'peerI', 3000, 'hashC1', 'sigI1'],
    ['/doc3.zip', 'peerJ', 3001, 'hashC1', 'sigJ1'],
    ['/doc3.zip', 'peerK', 3002, 'hashC2', 'sigK2'],
    ['/doc3.zip', 'peerL', 3003, 'hashC2', 'sigL2']
];

export const exampleFileHierarchy = {
    '/readme.md': {
        'hashRM1': {
            peers: {
                'peerA': { timestamp: 1000, signature: 'sigRM1A' }
            }
        }
    },

    '/docs': {
        'hashDOCSFILE1': {
            peers: {
                'peerB': { timestamp: 1010, signature: 'sigDOCSFILE1B' }
            }
        }
    },

    '/docs-backup/notes.txt': {
        'hashDBK1': {
            peers: {
                'peerC': { timestamp: 1020, signature: 'sigDBK1C' }
            }
        }
    },

    '/docs-backup/archive/old-notes.txt': {
        'hashDBK2': {
            peers: {
                'peerD': { timestamp: 1021, signature: 'sigDBK2D' }
            }
        }
    },

    '/docs/readme.txt': {
        'hashDR1': {
            peers: {
                'peerE': { timestamp: 1030, signature: 'sigDR1E' },
                'peerF': { timestamp: 1031, signature: 'sigDR1F' }
            }
        }
    },

    '/docs/guide/intro.md': {
        'hashDGI1': {
            peers: {
                'peerG': { timestamp: 1040, signature: 'sigDGI1G' }
            }
        }
    },

    '/docs/guide/advanced/details.md': {
        'hashDGAD1': {
            peers: {
                'peerH': { timestamp: 1050, signature: 'sigDGAD1H' }
            }
        }
    },

    '/docs/guide/advanced/appendix/notes.md': {
        'hashDGAAN1': {
            peers: {
                'peerI': { timestamp: 1060, signature: 'sigDGAAN1I' }
            }
        }
    },

    '/a/a.txt': {
        'hashAA1': {
            peers: {
                'peerJ': { timestamp: 1070, signature: 'sigAA1J' }
            }
        }
    },

    '/a/a/a.txt': {
        'hashAAA1': {
            peers: {
                'peerK': { timestamp: 1071, signature: 'sigAAA1K' }
            }
        }
    },

    '/a/a/a/a.txt': {
        'hashAAAA1': {
            peers: {
                'peerL': { timestamp: 1072, signature: 'sigAAAA1L' }
            }
        }
    },

    '/media/photos/vacation/2023/summer.png': {
        'hashSUM1': {
            peers: {
                'peerM': { timestamp: 2000, signature: 'sigSUM1M' },
                'peerN': { timestamp: 2001, signature: 'sigSUM1N' }
            }
        },
        'hashSUM2': {
            peers: {
                'peerO': { timestamp: 2002, signature: 'sigSUM2O' }
            }
        }
    },

    '/media/photos/vacation/2023/winter.png': {
        'hashWIN1': {
            peers: {
                'peerP': { timestamp: 2010, signature: 'sigWIN1P' }
            }
        }
    },
    
    '/media/photos/profile.jpg': {
        'hashPROF1': {
            peers: {
                'peerQ': { timestamp: 2020, signature: 'sigPROF1Q' }
            }
        }
    },

    '/media/videos/clip.mp4': {
        'hashCLIP1': {
            peers: {
                'peerR': { timestamp: 2030, signature: 'sigCLIP1R' },
                'peerS': { timestamp: 2031, signature: 'sigCLIP1S' },
                'peerT': { timestamp: 2032, signature: 'sigCLIP1T' }
            }
        }
    },

    '/projects/pearcore/README.md': {
        'hashPCRM1': {
            peers: {
                'peerU': { timestamp: 3000, signature: 'sigPCRM1U' }
            }
        }
    },
    '/projects/pearcore/src/index.js': {
        'hashPCI1': {
            peers: {
                'peerV': { timestamp: 3010, signature: 'sigPCI1V' }
            }
        }
    },
    '/projects/pearcore/src/utils/helper.js': {
        'hashPCH1': {
            peers: {
                'peerW': { timestamp: 3020, signature: 'sigPCH1W' }
            }
        }
    },
    '/projects/another-project/README.md': {
        'hashAPRM1': {
            peers: {
                'peerX': { timestamp: 3030, signature: 'sigAPRM1X' }
            }
        }
    },

    '/shared docs/file with spaces.txt': {
        'hashSWS1': {
            peers: {
                'peerY': { timestamp: 4000, signature: 'sigSWS1Y' }
            }
        }
    },

    '/.hidden/config.json': {
        'hashHIDE1': {
            peers: {
                'peerZ': { timestamp: 5000, signature: 'sigHIDE1Z' }
            }
        }
    },

    '/UPPERCASE/File.TXT': {
        'hashUPPER1': {
            peers: {
                'peerAA': { timestamp: 6000, signature: 'sigUPPER1AA' }
            }
        }
    },

    '/日本語/ファイル.txt': {
        'hashJP1': {
            peers: {
                'peerBB': { timestamp: 7000, signature: 'sigJP1BB' }
            }
        }
    },

    '/LICENSE': {
        'hashLIC1': {
            peers: {
                'peerCC': { timestamp: 8000, signature: 'sigLIC1CC' }
            }
        }
    },

};