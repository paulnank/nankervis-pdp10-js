# DECsystem-10 (PDP-10 KI10) diagnostics in Javascript 


This folder contains advanced material for debugging a PDP-10 CPU. Please ignore it unless you plan to do some serious debugging!

These are Javascript diagnotics for the DECsystem-10 (PDP-10 KI10) emulator at: [https://skn.noip.me/pdp10/pdp10.html](https://skn.noip.me/pdp10/pdp10.html)

The sources for the KI10 KLAD diagnostics can be found at [http://pdp-10.trailing-edge.com/klad_sources/index.html](http://pdp-10.trailing-edge.com/klad_sources/index.html). Javascript versions were produced from the related .sav files using a python script.

The KI10 specific materials for the PDP-10 CPU diagnostics all have the prefix DBK and they are in order of increasinly complex testing. So the first and simplest is dbkaa.*

More advanced diagnostics also require that diamon and subrtn are loaded before execution. This is done by editing pdp10.html to include the desired javascript files.

Most of the simpler diagnostics are able to be run under TOPS-10 as below...


```
Paul Nankervis - paulnank@hotmail.com

Boot> b dpa0
Press RETURN to continue loading BOOTS...

<CR>

KI603 (VM) 04-21-78
WHY RELOAD: sched
DATE: 13-dec-78
TIME: 1121

STARTUP OPTION: quick

%CONTROLLER RPA IS OFF-LINE

%CONTROLLER RPB IS OFF-LINE

%CONTROLLER DPB IS OFF-LINE

KI603 (VM) 11:21:10 CTY system 514

.LOGIN 1,2
JOB 1 KI603 (VM) CTY
Password: failsa
1121    13-Dec-78       Wed

.RUN DIAMON


* DIAMON [DDQDC] - DECSYSTEM DIAGNOSTIC MONITOR - VER 0.15 *

PROGRAM NOT FOUND - KLDDT. 

DIAMON CMD - DBKAA

PDP-10 KI10 BASIC INSTRUCTION DIAGNOSTIC (1) [DBKAA]

DIAMON CMD - DBKAB

PDP-10 KI10 BASIC INSTRUCTION DIAGNOSTIC (2) [DBKAB]

DIAMON CMD - DBKAC

PDP-10 KA10 BASIC INSTRUCTION DIAGNOSTIC (3) [DAKAC]

DIAMON CMD - DBKAD

PDP-10 KI10 BASIC INSTRUCTION DIAGNOSTIC (4) [DBKAD]

DIAMON CMD - DBKAE

PDP-10 KI10 BASIC INSTRUCTION DIAGNOSTIC (5) [DBKAE]

DIAMON CMD - DBKAF

PDP-10 KI10 BASIC INSTRUCTION DIAGNOSTIC (6) [DBKAF]

DIAMON CMD - DBKAG

PDP-10 KI10 BASIC INSTRUCTION DIAGNOSTIC (7) [DBKAG]

DIAMON CMD - DBKAH
?
?Illegal instruction at user PC 030707

.
```
