// Javascript emulation code for main CPU in a DECsystem-10 (PDP-10 KI10) 
// See https://skn.noip.me/pdp10/pdp10.html for more information

// Quotation of the day: "36 bits is a royal pain when you only have 32 bits for bit operations!" - Me, Now!


const
    BIT35 = 0o1,
    BIT34 = 0o2,
    BIT33 = 0o4,
    BIT32 = 0o10,
    BIT31 = 0o20,
    BIT30 = 0o40,
    BIT29 = 0o100,
    BIT28 = 0o200,
    BIT27 = 0o400,
    BIT26 = 0o1000,
    BIT25 = 0o2000,
    BIT24 = 0o4000,
    BIT23 = 0o10000,
    BIT22 = 0o20000,
    BIT21 = 0o40000,
    BIT20 = 0o100000,
    BIT19 = 0o200000,
    BIT18 = 0o400000,
    BIT17 = 0o1000000,
    BIT16 = 0o2000000,
    BIT15 = 0o4000000,
    BIT14 = 0o10000000,
    BIT13 = 0o20000000,
    BIT12 = 0o40000000,
    BIT11 = 0o100000000,
    BIT10 = 0o200000000,
    BIT9 = 0o400000000,
    BIT8 = 0o1000000000,
    BIT7 = 0o2000000000,
    BIT6 = 0o4000000000,
    BIT5 = 0o10000000000,
    BIT4 = 0o20000000000,
    BIT3 = 0o40000000000,
    BIT2 = 0o100000000000,
    BIT1 = 0o200000000000,
    BIT0 = 0o400000000000, // 2^35
    wordBase = 0x1000000000, // 2^36
    wordMask = wordBase - 1,
    wordSign = BIT0,
    halfBase = BIT17,
    halfMask = halfBase - 1,
    halfSign = BIT18;


// Flags: AOV C0  C1  FOV FPD USR IOT PUB AFI TR2 TR1 FXU DCX 0 0 0 0 0
//         0   1   2   3   4   5   6   7   8   9  10  11  12
const
    flagAOV = 0o400000, // - arithmetic overflow from ASH MUL FIX etc
    flagC0 = 0o200000, // - carry in add/sub from bit 0
    flagC1 = 0o100000, // - carry in add/sub from bit 1
    flagFOV = 0o40000, // - floating overflow (exponent > 127) / underflow
    flagFPD = 0o20000, // - first part done
    flagUSR = 0o10000, // - processor in user mode 010000
    flagIOT = 0o4000, // - processor in In Out mode 04000
    flagPUB = 0o2000, // - public or exec supervisor mode
    flagAFI = 0o1000, // - address failure inhibit
    flagTR2 = 0o400, // - pushdown overflow
    flagTR1 = 0o200, // - arithmetic overflow
    flagFXU = 0o100, // - floating exponent underflow
    flagDCX = 0o40, // - divide check , div by 0 etc
    flagTR3 = flagTR1 | flagTR2; // both trap flags

const // accessType bit mask values
    accessReadPXCT = 1, // Matches PXCT read modify bit
    accessWritePXCT = 2, // Matches PXCT write modify bit
    accessPXCT = accessReadPXCT | accessWritePXCT, // Any PXCT bits
    accessRead = 16, // Read access requested
    accessWrite = 32, // Write access
    accessExecute = 64, // Execute (instruction fetch)
    accessModify = accessRead | accessWrite;

var CPU = {
    PC: 0, // instruction PC
    PXCTflags: 0, // privilege XCT flags (these change register set and addressing so big impact)
    accumulator: null, // current accumulator set (points into fastMemory array)
    checkInterruptFlag: 1,
    dataLights: 0,
    execTable: 0, // base address of exec map
    fastMemory: [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Four blocks of 16 accumulators
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    ],
    flags: 0, // CPU flags
	halt: 0, // 1 not running, 2 halt switch on
    instructionLights: 0,
    interruptMode: 0, // flag whether instruction is executing in interrupt mode - will change during some instructions
    interruptQueue: [],
    interruptSkip: 0,
    lastMode: 0,
    lastVirtualAddress: 0,
    loopBase: 59, // number of instructions executed per 8ms
    loopCount: 0, // instructions left in current 8ms batch
    loopPause: 0, // slow instruction rate until disk I/O completes
    memory: new Array(0o20000000).fill(0), // Main CPU.memory
    miscLights: 3, // RUN & POWER
    modifyAddress: -1, // last memory read address for memory rewrite cycle
    modifyType: -1, // last memory read type (accumulator, physical memory etc) in case rewrite cycle required
    pageEnable: 0, // paging on or off
    pageFail: 0,
    pageFault: 1,
    pendingLights: 0,
    resultAC: -1, // instruction result type (accumulator, virtual memory etc)
    resultAddress: -1, // instruction result address (accumulator number, virtual address, etc)
    smallUser: 0, // user mode small addressing on or off
    userMode: 0, // current processor mode (may differ from flags during an interrupt)
    userRegisterSet: 0, // Which accumulator set for usermode
    userTable: 0 // base address of user map
};

function resetCPU() {
    "use strict";
    pi.coniStatus = 0; // Nuke status completely
    CPU.interruptQueue = [];
    CPU.checkInterruptFlag = 1;
    writeFlags(0);
}

setUserMode(0);

// Instruction logging stuff - useful ONLY in browser debugging mode!!
var log = {
    limit: 0, // Size of instruction log (0 is off)
    debugPC: 0, // PC for debugging - used for setting browser breakpoint when the PC reaches this value
    ring: [] // Data for instruction logging (for debugging)
};

// Debug routine to print the contents of the instruction log
function log_print() {
    "use strict";
    var i;
    function toOct(n, l) {
        if (typeof n === "undefined") return "undefined";
        var o = n.toString(8);
        if (o.length < l) o = "0".repeat(l - o.length) + o;
        return o;
    }
    console.log("PC       ACC           EA       flags      Instruction   Name  AC");
    for (i = 0; i < log.ring.length; i++) {
        console.log(toOct(log.ring[i][0], 6) + "   " + toOct(log.ring[i][1], 12) + "  " + toOct(log.ring[i][2], 6) + "  " + toOct(log.ring[i][3], 6) + "  " + toOct(log.ring[i][4], 12) + "  " + log.ring[i][5] + " " + log.ring[i][6].toString(8) + "," + right(log.ring[i][4]).toString(8));
    }
    return "";
}

// Add an intruction log debug entry
function LOG_INSTRUCTION(instruction, AC, effectiveAddress, name) {
    "use strict";
    if (log.limit) {
        log.ring.push([CPU.PC, CPU.accumulator[AC], effectiveAddress, CPU.flags, instruction, name, AC]);
        while (log.ring.length > log.limit) {
            log.ring.shift();
        }
		if (CPU.PC - 1 == log.debugPC) {
			console.log("DEBUG PC: " + (CPU.PC - 1).toString(8) + " " + CPU.accumulator[AC].toString(8) + " " + effectiveAddress.toString(8) + " " + CPU.flags.toString(8) + " " + instruction.toString(8) + " " + name + " " + AC.toString(8) + "," + right(instruction).toString(8));
			log.debug = 2;
		}
	}
}

// Debugging check that a memory word is in range and has the correct type
function checkData(data) {
    "use strict";
    if (typeof data == "undefined" || !Number.isInteger(data) || data < 0 || data >= wordBase) {
        console.log("Bad data: " + data + " @" + CPU.PC.toString(8));
        panic(); //debug
    }
}

// Debugging check that a memory address is in range and has the correct type
function checkVirtual(address) {
    "use strict";
    if (typeof address == "undefined" || !Number.isInteger(address) || address < 0 || address >= halfBase) {
        panic(); //debug
    }
}

// Generate a power of 2
function power2(power) { // Math.pow(2, power)  is so slow....
    "use strict";
    var result = 1;
    if (power >= 0) {
        if (power < 31) {
            return 1 << power;
        }
        while (power > 30) {
            result *= 1 << 30;
            power -= 30;
        }
        return result * (1 << power);
    } else {
        while (power < -30) {
            result /= 1 << 30;
            power += 30;
        }
        return result / (1 << -power);
    }
}

function left(operand) { // extract left 18 bit halfword from full 36 bit word
    "use strict";
    return Math.trunc(operand / halfBase);
}

function right(operand) { // extract right 18 bit halfword from full 36 bit word
    "use strict";
    return operand & halfMask;
}

function combine(left, right) { // assemble 36 bit word from two 18 bit half words
    "use strict";
    return ((left & halfMask) * halfBase) + (right & halfMask);
}

function nextAC(AC) {
    "use strict";
	return (AC + 1) & 0xf;
}

function incrAddress(address) {
    "use strict";
    return (address + 1) & halfMask;
}

function setUserMode(userMode) {
    "use strict";
    if (userMode) {
        CPU.userMode = 1;
        CPU.accumulator = CPU.fastMemory[CPU.userRegisterSet];
    } else {
        CPU.userMode = 0;
        CPU.accumulator = CPU.fastMemory[0];
    }
}

function writeFlags(flags) {
    "use strict";
    if ((CPU.flags ^ flags) & flagUSR) { // If CPU mode is changing...
        setUserMode(flags & flagUSR);
    }
    CPU.flags = flags;
}

function setFlags(mask) {
    "use strict";
    if (CPU.interruptMode) {
        mask &= ~(flagAOV | flagTR1 | flagTR2); // Interrupt instructions don't set Overflow or either trap
    }
    if (mask & flagUSR) {
        setUserMode(1);
    }
    CPU.flags |= mask;
}

function clearFlags(mask) {
    "use strict";
    if (mask & flagUSR) {
        setUserMode(0);
    }
    CPU.flags &= ~mask;
}

function ifPrivilege() {
    "use strict";
    return (!(CPU.flags & flagPUB) && (!CPU.userMode || (CPU.flags & flagIOT)));
}

function inPublicMode() {
    "use strict";
    return (CPU.flags & flagPUB);
}

function getPCword() {
	"use strict";
	var saveFlags = CPU.flags;
	if (!(CPU.flags & flagUSR)) {
		saveFlags &= ~flagAOV;	// flagAOV has special meaning in exec mode - don't save it
	}
	return combine(saveFlags, CPU.PC);
}

const operationName = ["", "I", "M", "S"];
const conditionName = ["", "L", "E", "LE", "A", "GE", "N", "G"];

function incrementWord(dst) {
    "use strict";
    dst++; // Increment
    if (dst >= wordBase) {
        dst -= wordBase;
        if (dst == wordSign) {
            setFlags(flagAOV | flagC1); // Set AOV, C1
        } else {
            setFlags(flagC0 | flagC1); // Set C0, C1
        }
    }
    return dst;
}

function decrementWord(dst) {
    "use strict";
    dst += wordMask; // Decrement
    if (dst >= wordBase) {
        dst -= wordBase;
        if (dst == wordSign) {
            setFlags(flagAOV | flagC1); // Set AOV, C1
        } else {
            setFlags(flagC0 | flagC1); // Set C0, C1
        }
    }
    return dst;
}

function compareWord(dst, operand) {
    "use strict";
    var result;
    if (operand == dst) {
        result = 0; // E
    } else {
        if (fromInteger(dst) >= fromInteger(operand)) {
            result = 1; // G
        } else {
            result = wordSign; // L
        }
    }
    return result;
}

function evaluateCondition(opCode, operand) {
    "use strict";
    switch (opCode & 0x7) {
        case 1: // L
            if (operand >= wordSign) {
                return 1;
            }
            break;
        case 2: // E
            if (!operand) {
                return 1;
            }
            break;
        case 3: // LE
            if (!operand || operand >= wordSign) {
                return 1;
            }
            break;
        case 4: // A
            return 1;
        case 5: // GE
            if (operand < wordSign) {
                return 1;
            }
            break;
        case 6: // N
            if (operand) {
                return 1;
            }
            break;
        case 7: // G
            if (operand && operand < wordSign) {
                return 1;
            }
            break;
    }
    return 0;
}

function jump(destination) {
    "use strict";
    CPU.PC = destination & halfMask;
}

function skip() {
    "use strict";
    jump(CPU.PC + 1);
}

function branchTest(opCode, operand, effectiveAddress) {
    "use strict";
    if (evaluateCondition(opCode, operand)) {
        jump(effectiveAddress);
    }
}

function skipTest(opCode, operand) { // For normal cases
    "use strict";
    if (evaluateCondition(opCode, operand)) {
        skip();
    }
}

function skipSpecial(condition) { // Skip special case for AOSX, SKIPX, SOSX, CONSX, BLKX for interrupt handling
    "use strict";
    if (condition) {
        if (!CPU.interruptMode) { // Non-interrupt skip...
            skip();
        }
    } else {
        CPU.interruptSkip = 0; // AOSX, SKIPX, SOSX, CONSX, BLKX interrupt skip condition
    }
}

function skipTestSpecial(opCode, operand) { // For AOSX, SKIPX, SOSX for interrupt cases
    "use strict";
    skipSpecial(evaluateCondition(opCode, operand));
}

function fromInteger(operand) { // Javascript number from PDP-10 integer word
    "use strict";
    if (operand >= wordSign) { // operand -ve
        operand -= wordBase; // convert to real -ve integer
    }
    return operand;
}

function toInteger(operand) { // Javascript integer to PDP-10 word
    "use strict";
    if (operand >= 0) {
        if (operand >= wordSign) {
            setFlags(flagAOV | flagC1); // Set AOV, C1
            operand %= wordSign;
        }
    } else {
        operand = -operand;
        if (operand > wordSign) {
            setFlags(flagAOV | flagC0); // Set AOV, C0
            operand %= wordSign;
            if (!operand) {
                operand = wordSign;
            }
        }
        operand = wordBase - operand;
    }
    return operand;
}

function readWordByPhysical(physicalAddress) {
    "use strict";
    var data;
    if (physicalAddress < 0 || physicalAddress >= BIT13) panic();
    data = CPU.memory[physicalAddress];
    //checkData(data);
    return data;
}

function writeWordByPhysical(physicalAddress, data) {
    "use strict";
    if (physicalAddress < 0 || physicalAddress >= BIT13) panic();
    //checkData(data);
    CPU.memory[physicalAddress] = data;
    return 0;
}

function readWordFromExecTable(tableAddress) {
    "use strict";
    if (CPU.pageEnable) {
        tableAddress = (CPU.execTable + tableAddress) & halfMask;
    }
    return readWordByPhysical(tableAddress);
}

function writeWordToExecTable(tableAddress, data) {
    "use strict";
    if (CPU.pageEnable) {
        tableAddress = (CPU.execTable + tableAddress) & halfMask;
    }
    return writeWordByPhysical(tableAddress, data);
}

function readWordFromUserTable(tableAddress) {
    "use strict";
    if (CPU.pageEnable) {
        tableAddress = (CPU.userTable + tableAddress) & halfMask;
    }
    return readWordByPhysical(tableAddress);
}

function writeWordToUserTable(tableAddress, data) {
    "use strict";
    if (CPU.pageEnable) {
        tableAddress = (CPU.userTable + tableAddress) & halfMask;
    }
    return writeWordByPhysical(tableAddress, data);
}

function readWordFromCurrentTable(tableAddress) {
    "use strict";
    if (CPU.userMode) {
        return readWordFromUserTable(tableAddress);
    } else {
        return readWordFromExecTable(tableAddress);
    }
}

// Source map: A P W S X  13 bit address
// Map output: F P W S N  13 bit address
// Map Fail --- U VirtPage --- O A W S T

// There are page tables for exec and user mode located using a base address for each.
// Exec addresses under 112K (0x1c000) are not paged, between 112K and 128K
// are paged using an extension to the USER map (!), and above 128K using the exec map.
// User addresses are all from the user map with enforcement for small
// mode addressing (addresses limited to 0-40000 and 400000-440000)
// Also need to homour public and concealed pages...
// Bit values for accessType: accessRead | accessWrite | accessExecute
// Return  Fail P W S NotPaged  Page (23-35) as per MAP instruction (pg 2-114)
function getVirtualMap(virtualAddress, accessType) {
    "use strict";
    var page, userMode, publicMode, pageData, pageFail;
    if (virtualAddress < 0 || virtualAddress > halfMask) panic();
    page = (virtualAddress >>> 9) & 0x1ff;
    if (!CPU.pageEnable) {
        return BIT22 | page; // NotPaged
    }

    userMode = CPU.userMode;
    publicMode = CPU.flags & flagPUB;
    if (accessType & accessPXCT) { // If any PXCT bits are set everything changes...
        if (accessType & accessRead) { // read or read/write access
            if (accessType & accessReadPXCT) { // PXCT read flag
                if (CPU.flags & flagIOT) { // context user
                    userMode = 1;
                }
                if (CPU.flags & flagAOV) { // context public
                    publicMode = 1;
                }
            }
        } else { // write only access
            if (accessType & accessWritePXCT) { // PXCT read flag
                if (CPU.flags & flagIOT) { // context user
                    userMode = 1;
                }
                if (CPU.flags & flagAOV) { // context public
                    publicMode = 1;
                }
            }
        }
    }

    if (!userMode) { // Exec space...
        if (page < 0o340) { // Low exec space is unmapped
            if (publicMode) { // Check if public access allowed
                if (!(accessType & accessExecute) || (left(CPU.memory[virtualAddress]) & 0o777040) != 0o0254040) {
                    CPU.pageFail = combine((userMode << 9) | page, 0o21);
                    return BIT18 | BIT22 | page; // Fail  NotPaged 021 Proprietary violation
                }
            }
            return BIT22 | page; // NotPaged
        }
        if (page < 0o400) { // Exec pages 340 - 400 are mapped by user map
            pageData = readWordFromUserTable((page >>> 1) + 0o220); // User Process Table locations 400-417
        } else { // Exec pages above 400 use exec map
            pageData = readWordFromExecTable(page >>> 1); // Exec Process Table locations 200-377
        }
    } else { // All user pages from user map!!
        if (CPU.smallUser && (page & 0o340)) { // Small user limited to pages 0-37 and 400-437
            CPU.pageFail = combine((userMode << 9) | page, 0o20); // 020 Small user violation
            return BIT18 | page; // Not sure if map data is required? no
        }
        pageData = readWordFromUserTable(page >>> 1); // User Process Table locations 0-377
    }

    if (!(page & 1)) {
        pageData = left(pageData);
    } else {
        pageData = right(pageData);
    }

    // Check for access error
    if (!(pageData & BIT18) || (!(pageData & BIT20) && (accessType & accessWrite))) {
        pageFail = (pageData >> 13) & 0o6; // get W & S bits
        if (pageData & BIT18) { // A bit
            pageFail |= 0o10;
        }
        if (accessType & accessWrite) { // T bit
            pageFail |= BIT35;
        }
        CPU.pageFail = combine((userMode << 9) | page, pageFail);
        if (pageData & BIT18) {
            return BIT18 | (pageData & 0o357777);
        } else {
            return 0o437777;
        }
    }

    // Check if not public page not from public mode...
    if (!(pageData & BIT19) && publicMode) { // Check if public access allowed
        if (!(accessType & accessExecute) || (left(CPU.memory[((pageData & 0x1ff) << 9) | (virtualAddress & 0x1ff)]) & 0o777040) != 0o0254040) { // JRST 1 portal acceess
            CPU.pageFail = combine((userMode << 9) | page, 0o21);
            return BIT18 | (pageData & 0o357777); // Fail  Paged 021 Proprietary violation
        }
    }

    // Set public flag if executing from public page...
    if ((pageData & BIT19) && (accessType & accessExecute)) {
        setFlags(flagPUB);
    }

    CPU.lastVirtualAddress = virtualAddress;
    CPU.lastMode = 0;

    return pageData & 0o357777; // Success with page data
}

// Page Failures are simpler than page faults seen in other computer systems
// They prevent the current instruction from updating the accumulators, PC, etc
// and then if enabled cause an optional trap.
// This routine uses getVirtualMap() to figure out all the mapping rules
// mapVirtualToPhysical() Convert an 18 bit virtual address into a 22 bit physical address
function mapVirtualToPhysical(virtualAddress, accessType) {
    "use strict";
    var physicalAddress, pageData;
    //checkVirtual(virtualAddress);
    if (!CPU.pageEnable) { // Virtual if paging off
        physicalAddress = virtualAddress;
    } else {
        pageData = getVirtualMap(virtualAddress, accessType);
        if (pageData & BIT18) { // Page Failure
            console.log("Pagefail " + virtualAddress.toString(8) + " " + accessType.toString(8) + " " + pageData.toString(8) + " " + CPU.savePC.toString(8) + " " + CPU.flags.toString(8) + " @"+CPU.PC.toString(8));
            // if interrupt active then cause device interrupt on device error channel (pg 2-109)
            // if (CPU.flags & flagAFI) { // then what?? depends on instruction fetch or operand Address Failure Inhibit flag
            //if (!(accessType & accessExecute)) {
            //    CPU.PC = decrAddress(CPU.PC); //CPU.PC = CPU.savePC; // Reset PC - ?????
            //}
			if (right(CPU.pageFail) != 0o21 || (accessType & accessWrite)) {
				CPU.PC = CPU.savePC; // Restore PC to except for proprietary read violation
			} // Alternate would be defer proprietary violation handling to next instruction cycle?
            if (!CPU.userMode) {
                writeWordToUserTable(0o426, CPU.pageFail); // Yes - exec page fail writes to user table! :-(
            } else {
                writeWordToUserTable(0o427, CPU.pageFail);
            }
            if (!CPU.interruptMode) { // scope of this exception?
                XCT(readWordFromCurrentTable(0o420), 1); // Execute 420 from current table (pagefail)
            }
            CPU.pageFault = 1;
            physicalAddress = -1;
        } else {
            if (pageData & BIT22) { // Not mapped
                physicalAddress = virtualAddress;
            } else { // Mapped
                physicalAddress = ((pageData & 0x1fff) << 9) | (virtualAddress & 0x1ff);
            }
        }
    }
    return physicalAddress;
}

function getWordByVirtual(virtualAddress, accessType) {
    "use strict";
    var addressType, data;
    if (virtualAddress < 16) { // Accumulator virtualAddress
        if (accessType & accessReadPXCT) { // PXCT read flag
            if (CPU.flags & flagIOT) { // flagIOT is also Previous Context User flag
                if (CPU.userRegisterSet) { // Selected user accumulator set
                    addressType = 2; // Alternate accumulator set
                    data = CPU.fastMemory[CPU.userRegisterSet][virtualAddress];
                } else { // User shadow area
                    if ((virtualAddress = mapVirtualToPhysical(virtualAddress, accessType)) < 0) { // Convert physical address to virtual
                        return virtualAddress;
                    }
                    addressType = 1; // Memory virtualAddress
                    data = CPU.memory[virtualAddress];
                }
            } else { // AC stack
                addressType = 3; // Executive stack in user table
                data = readWordFromUserTable(pag.executiveStack + virtualAddress);
            }
        } else { // Normal accumulator
            addressType = 0; // Normal accumulator
            data = CPU.accumulator[virtualAddress];
        }
    } else { // Normal memory access
        if ((virtualAddress = mapVirtualToPhysical(virtualAddress, accessType)) < 0) { // Convert physical virtualAddress to virtual
            return virtualAddress;
        }
        addressType = 1; // Memory virtualAddress
        data = CPU.memory[virtualAddress];
        CPU.dataLights = data; // Not really but I dunno what it should display yet
    }
    //checkData(data);
    if (accessType & accessWrite) {
        CPU.modifyType = addressType;
        CPU.modifyAddress = virtualAddress;
    } else {
        CPU.modifyType = -1; // DEBUG
    }
    return data;
}

function readWordByVirtual(virtualAddress) { // Normal case read word which honours PXCT flags
    "use strict";
    return getWordByVirtual(virtualAddress, accessRead | CPU.PXCTflags);
}

function writeWordByVirtual(virtualAddress, data) {
    "use strict";
    var physicalAddress;
    //checkData(data);
    if (virtualAddress < 16) { // Accumulator address
        if (CPU.PXCTflags & accessWritePXCT) { // PXCT write flag - all writes honour PXCT flags
            if (CPU.flags & flagIOT) { // flagIOT is Previous context user
                if (CPU.userRegisterSet) { // Selected user block
                    CPU.fastMemory[CPU.userRegisterSet][virtualAddress] = data;
                } else { // User shadow area
                    if ((physicalAddress = mapVirtualToPhysical(virtualAddress, accessWrite | CPU.PXCTflags)) < 0) {
                        return physicalAddress;
                    }
                    CPU.memory[physicalAddress] = data;
                }
            } else { // AC stack
                return writeWordToUserTable(pag.executiveStack + virtualAddress, data);
            }
        } else { // Normal accumulator
            CPU.accumulator[virtualAddress] = data;
        }
    } else { // Normal memory access
        if ((physicalAddress = mapVirtualToPhysical(virtualAddress, accessWrite | CPU.PXCTflags)) < 0) {
            return physicalAddress;
        }
        CPU.memory[physicalAddress] = data;
    }
    CPU.modifyType = -1; // DEBUG
    return data;
}

// modifyWord() is used after a getWordByVirtual() call to rewrite or modify the content that was
// just read. CPU.modifyType remembers whether the source was an accumulator, memory, a user register
// or the executive stack, while CPU.modifyAddress remembers the appropriate address.
function modifyWord(data) {
    "use strict";
    //checkData(data);
    switch (CPU.modifyType) { // Set by getWordByVirtual()
        case 0: // Current accumulator set
            CPU.accumulator[CPU.modifyAddress] = data;
            break;
        case 1: // Memory access
            CPU.memory[CPU.modifyAddress] = data;
            break;
        case 2: // Alternate accumulator set
            CPU.fastMemory[CPU.userRegisterSet][CPU.modifyAddress] = data;
            break;
        case 3: // Executive stack in user table
            return writeWordToUserTable(pag.executiveStack + CPU.modifyAddress, data);
        default:
            panic();
            break;
    }
    CPU.modifyType = -1; // DEBUG
    return 0;
}

// writeWordByOperand() will write a word to an accumulator or virtual address
// or both depending on the opCode
// Four types of write instructions: 0:M 1:I 2:M 3:S
// 0: C(AC)
// 1: C(AC)
// 2: C(E)
// 3: C(E) & C(AC)
function writeWordByOperand(opCode, data, AC, effectiveAddress) {
    "use strict";
    var result = 0;
    opCode &= 0x3;
    if (opCode >= 2) {
        if ((result = writeWordByVirtual(effectiveAddress, data)) < 0) {
            return result;
        }
    }
    if (opCode != 2) {
        CPU.accumulator[AC] = data;
    }
    return 0;
}

// readWordForOperand() reads a word for a general instruction and sets up
// CPU.resultAC and CPU.resultAddress so that a subsequent call to writeResult()
// will write to the correct location(s).
// Four types of general instruction operations:
// 0    C(AC) <- C(AC) . C(E)
// 1 I  C(AC) <- C(AC) . 0,,E
// 2 M  C(E)  <- C(AC) . C(E)
// 3 B  C(AC) <- C(AC) . C(E); C(E) <- C(AC)
function readWordForOperand(opCode, AC, effectiveAddress) {
    "use strict";
    CPU.resultAC = AC; // Default is use accumulator for writeResult()
    CPU.resultAddress = -1; // -1 for no memory result (-2 is modify)
    switch (opCode & 0x3) {
        case 0: //  C(AC) <- C(AC) . C(E)
            return readWordByVirtual(effectiveAddress);
        case 1: //  C(AC) <- C(AC) . 0,,E
            return effectiveAddress;
        case 2: //  C(E)  <- C(AC) . C(E)
			CPU.resultAC = -1; // No accumulator result
            CPU.resultAddress = -2; // -2 for memory modify cycle
            return getWordByVirtual(effectiveAddress, accessModify | CPU.PXCTflags);
        case 3: //  C(AC) <- C(AC) . C(E); C(E) <- C(AC)
            CPU.resultAddress = -2; // -2 for memory modify cycle
            return getWordByVirtual(effectiveAddress, accessModify | CPU.PXCTflags);
    }
}

// readWordForMove() reads a word for a move type instruction and sets up
// CPU.resultAC and CPU.resultAddress so that a subsequent call to writeResult()
// will write to the correct location(s).
// Four types of move instructions:-
// C(AC) <- C(E)
// C(AC) <- 0,,E
// C(E)  <- C(AC)
// C(E)  <- C(E); if AC#0 then C(AC) <- C(E)
function readWordForMove(opCode, AC, effectiveAddress) {
    "use strict";
    CPU.resultAC = AC; // Default is use accumulator for writeResult()
    CPU.resultAddress = -1; // -1 is don't write a result (-2 is modify)
    switch (opCode & 0x3) {
        case 0: //  C(AC) <- C(E)
            return readWordByVirtual(effectiveAddress);
        case 1: //  C(AC) <- 0,,E
            return effectiveAddress;
        case 2: //   C(E) <- C(AC)
			CPU.resultAC = -1; // No accumulator result
            CPU.resultAddress = effectiveAddress;
            return CPU.accumulator[AC];
        case 3: //   C(E) <- C(E); if AC#0 then C(AC) <- C(E)
            if (!AC) {
                CPU.resultAC = -1;
            }
            CPU.resultAddress = -2; // -2 a modify cycle
            return getWordByVirtual(effectiveAddress, accessModify | CPU.PXCTflags);
    }
}

// writeResult() writes an operand to the location(s) set up by prior
// calls to the readWordForOperand() and readWordForMove() functions.
// The location(s) for the write type are remembered in two variables:
//  CPU.resultAC which is the accumulator to write to (or -1 if none)
//  CPU.resultAddress which is the virtual address to write to (or -1 if none, or -2 for a modify)
function writeResult(data) {
    "use strict";
    var result;
    if (CPU.resultAddress == -1 && CPU.resultAC < 0) panic();
    if (CPU.resultAddress >= 0) {
        if ((result = writeWordByVirtual(CPU.resultAddress, data)) < 0) {
            return result;
        }
    } else {
        if (CPU.resultAddress === -2) { // Modify the word read previously
            if ((result = modifyWord(data)) < 0) {
                return result;
            }
        }
    }
    if (CPU.resultAC >= 0) {
        CPU.accumulator[CPU.resultAC] = data;
    }
    CPU.resultAC = -1; // DEBUG clear address fields
    CPU.resultAddress = -1;
    return 0;
}

const halfWordNames = [
    "HLL", "XHLLI", "HLLM", "HLLS", "HRL", "HRLI", "HRLM", "HRLS",
    "HLLZ", "HLLZI", "HLLZM", "HLLZS", "HRLZ", "HRLZI", "HRLZM", "HRLZS",
    "HLLO", "HLLOI", "HLLOM", "HLLOS", "HRLO", "HRLOI", "HRLOM", "HRLOS",
    "HLLE", "HLLEI", "HLLEM", "HLLES", "HRLE", "HRLEI", "HRLEM", "HRLES",
    "HRR", "HRRI", "HRRM", "HRRS", "HLR", "HLRI", "HLRM", "HLRS",
    "HRRZ", "HRRZI", "HRRZM", "HRRZS", "HLRZ", "HLRZI", "HLRZM", "HLRZS",
    "HRRO", "HRROI", "HRROM", "HRROS", "HLRO", "HLROI", "HLROM", "HLROS",
    "HRRE", "HRREI", "HRREM", "HRRES", "HLRE", "HLREI", "HLREM", "HLRES"
];

// Halfword |R right to |R right    |  no modification of other half    |  from memory to AC
//          |L left     |L left     |Z zero other half                  |I Immediate
//                                  |O set other half to ones           |M from AC to memory
//                                  |E sign extend source to other half |S to self. If AC#0, then move to AC also.
// Example of a halfWord op:
// HRL  CL(AC) <- CR(E)
// HRLI CL(AC) <- E
// HRLM CL(E)  <- CR(AC)
// HRLS CL(E)  <- CR(E); if AC#0 then CL(AC) <- CR(E)

function halfWord(opCode, AC, effectiveAddress) {
    "use strict";
    var operand, dst;
    if ((dst = readWordForMove(opCode, AC, effectiveAddress)) >= 0) {
        if ((opCode ^ (opCode >>> 3)) & 0x4) { // source half depends on which block of opCodes
            operand = right(dst);
        } else {
            operand = left(dst);
        }
        switch ((opCode >> 3) & 0x3) { // four types of fill:  insert, zero, ones, sign extend
            case 0: // insert into destination (so need destination)
                switch (opCode & 0x3) {
                    case 2: // Shame this is needed - doesn't fit in well at all
                        if ((dst = readWordByVirtual(effectiveAddress)) < 0) {
                            return dst;
                        }
                        break;
                    case 3:
                        break; // do nothing as dst preloaded above
                    default: // preload from acc
                        dst = CPU.accumulator[AC];
                        break;
                }
                break;
            case 1: // zero fill
                dst = 0;
                break;
            case 2: // 1 fill
                dst = wordMask;
                break;
            case 3: // extend
                if (operand & halfSign) {
                    dst = wordMask;
                } else {
                    dst = 0;
                }
                break;
        }
        if (opCode & BIT30) {
            dst = combine(left(dst), operand);
        } else {
            dst = combine(operand, right(dst));
        }
        writeResult(dst);
    }
}

const bitTestNames = [
    "TRN", "TLN", "TRNE", "TLNE", "TRNA", "TLNA", "TRNN", "TLNN",
    "TDN", "TSN", "TDNE", "TSNE", "TDNA", "TSNA", "TDNN", "TSNN",
    "TRZ", "TLZ", "TRZE", "TLZE", "TRZA", "TLZA", "TRZN", "TLZN",
    "TDZ", "TSZ", "TDZE", "TSZE", "TDZA", "TSZA", "TDZN", "TSZN",
    "TRC", "TLC", "TRCE", "TLCE", "TRCA", "TLCA", "TRCN", "TLCN",
    "TDC", "TSC", "TDCE", "TSCE", "TDCA", "TSCA", "TDCN", "TSCN",
    "TRO", "TLO", "TROE", "TLOE", "TROA", "TLOA", "TRON", "TLON",
    "TDO", "TSO", "TDOE", "TSOE", "TDOA", "TSOA", "TDON", "TSON"
];

// bit Test |R right half immediate |N no modification          |  never skip
//          |L left half immediate  |Z zero selected bits       |N skip unless all selected bits are zero
//          |D direct mask          |O set selected bits to One |E skip if all selected bits are zero
//          |S swapped mask         |C complement selected bits |A skip always
// Example of a bit Test op:
// TSC Test Swapped, Complement, but Do Not Skip
// TSCE Test Swapped, Complement, and Skip if All Masked Bits Equal zero
// TSCA Test Swapped, Complement, but Always Skip
// TSCN Test Swapped, Complement, and Skip if Not All Masked Bits Equal zero

function bitTest(opCode, AC, effectiveAddress) {
    "use strict";
    var operand, dst;
    switch (opCode & 0x9) { // Note: non-consecutive bits in mask
        case 0: // R right half immediate
            operand = effectiveAddress;
            break;
        case 1: // L left half immediate
            operand = combine(effectiveAddress, 0);
            break;
        case 8: // D direct mask
        case 9: // S swapped mask
            if ((operand = readWordByVirtual(effectiveAddress)) < 0) { // get C(E)
                return;
            }
            if (opCode & 1) { // S swapped mask
                operand = combine(right(operand), left(operand));
            }
            break;
    }
    dst = CPU.accumulator[AC]; // get C(AC)
    switch ((opCode >> 1) & 0x3) { // Do skip stuff
        case 0: // Never skip
            break;
        case 1: // E skip if all selected bits are zero
            if (!(left(operand) & left(dst)) && !(right(operand) & right(dst))) {
                skip();
            }
            break;
        case 2: // A skip always
            skip();
            break;
        case 3: // N skip unless all selected bits are zero
            if ((left(operand) & left(dst)) || (right(operand) & right(dst))) {
                skip();
            }
            break;
    }
    switch ((opCode >> 4) & 0x3) { // Do AC modification
        case 0: // N no modification
            break;
        case 1: // Z zero selected bits
            dst = combine(left(dst) & ~left(operand), right(dst) & ~right(operand));
            break;
        case 2: // C complement selected bits
            dst = combine(left(dst) ^ left(operand), right(dst) ^ right(operand));
            break;
        case 3: // O set selected bits to One
            dst = combine(left(dst) | left(operand), right(dst) | right(operand));
            break;
    }
    CPU.accumulator[AC] = dst;
}

// Convert single word to base 18 for multi-part multiply and divide
function toBase18Single(singleWord) { // Single word operand to up to two segments of 18 bits
    "use strict";
    if (singleWord >= wordSign) {
        singleWord = wordBase - singleWord; // Complement if negative
    }
    if (singleWord) {
        if (singleWord >= halfBase) {
            return [Math.trunc(singleWord / halfBase), singleWord % halfBase];
        } else {
            return [singleWord];
        }
    }
    return [];
}

// Convert double word (without sign) to base 18 for multi-part multiply and divide
function toBase18Double(doubleWord) { // Double word operand of 35 bits each to up to four segments of 18 bits
    "use strict";
    var hiWord = doubleWord[0],
        loWord = doubleWord[1];
    if (hiWord % 2) {
        loWord += wordSign; // Move 1 bit from hi word to lo word to make it 36 bit
    }
    hiWord = Math.trunc(hiWord / 2);
    return [Math.trunc(hiWord / halfBase), hiWord % halfBase, Math.trunc(loWord / halfBase), loWord % halfBase];
}

// Convert variable length base 18 back into a double word (right alignment required)
function fromBase18(doubleWord, lowBase, sign) {
    "use strict";
    var baseLength = lowBase.length;
    doubleWord[0] = 0;
    doubleWord[1] = 0;
    if (--baseLength >= 0) {
        doubleWord[1] = lowBase[baseLength];
        if (--baseLength >= 0) {
            doubleWord[1] += lowBase[baseLength] * halfBase;
            if (doubleWord[1] >= wordSign) {
                doubleWord[1] -= wordSign;
                doubleWord[0] = 1;
            }
            if (--baseLength >= 0) {
                doubleWord[0] += lowBase[baseLength] * 2;
                if (--baseLength >= 0) {
                    doubleWord[0] += lowBase[baseLength] * halfBase * 2;
                }
            }
        }
    }
    if (sign < 0) {
        DMOVN(doubleWord); // Complement negative result
    }
    if (doubleWord[0] >= wordSign) {
        doubleWord[1] += wordSign; // Copy sign bit for integer types (floats don't do this)
    }
}

// IMUL  C(AC) <- C(AC) * C(E);
// IMULI C(AC) <- C(AC) * E;
// IMULM C(E)  <- C(AC) * C(E);
// IMULB C(AC) <- C(AC) * C(E);  C(E) <- C(AC);

function IMUL(opCode, AC, effectiveAddress) {
    "use strict";
    var operand, result, overflow = 0;
    if ((operand = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
		result = fromInteger(CPU.accumulator[AC]) * fromInteger(operand);
		if (result >= -wordSign && result < wordSign) {
			result = toInteger(result);
		} else {
			overflow = 1;
			result = (((left(CPU.accumulator[AC]) * right(operand) + right(CPU.accumulator[AC]) * left(operand)) % halfBase) * halfBase +
					right(CPU.accumulator[AC]) * right(operand)) % wordSign + (result < 0 ? wordSign : 0);
		}
		if (writeResult(result) >= 0) {
			if (overflow) {
				setFlags(flagAOV | flagTR1);
			}
		}
	}
}

// MUL  C(AC AC+1) <- C(AC) * C(E);
// MULI C(AC AC+1) <- C(AC) * E;
// MULM C(E) <- high word of product of C(AC) * C(E);
// MULB C(AC AC+1) <- C(AC) * C(E);  C(E) <- C(AC);

function MUL(opCode, AC, effectiveAddress) {
    "use strict";
    var operand, acc, product, result;
    if ((operand = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
		acc = CPU.accumulator[AC];
		product = fromInteger(acc) * fromInteger(operand); // Piece of cake - now to store in PDP10 double word...
		result = Math.floor(product / wordSign);
		if (product < 0) {
			if (result) {
				result = wordBase + result;
			} else {
				result = wordMask;
			}
		}
		if (writeResult(result) >= 0) {
			if (acc == wordSign && operand == wordSign) {
				setFlags(flagTR1 | flagAOV); // Overflow 
				product = -wordSign;  // force sign bit in second word
			}
			if ((opCode & 0x3) != 2) {
				if (product < Number.MIN_SAFE_INTEGER || product > Number.MAX_SAFE_INTEGER) {
					result = (((left(acc) * right(operand) + right(acc) * left(operand)) % halfBase)
						* halfBase + right(acc) * right(operand)) % wordSign + (product < 0 ? wordSign : 0);
				} else {
					result = product % wordSign;
					if (product < 0) {
						if (result) {
							result = wordBase + result;
						} else {
							result = wordSign;
						}
					}
				}
				CPU.accumulator[nextAC(AC)] = result;
			}
		}
	}
}

// DIV  C(AC) <- C(AC AC+1) / C(E); C(AC+1) <- remainder;
// DIVI C(AC) <- C(AC AC+1) / E;    C(AC+1) <- remainder;
// DIVM C(E)  <- C(AC AC+1) / E;
// DIVB C(AC) <- C(AC AC+1) / C(E); C(AC+1) <- remainder;  C(E) <- C(AC);

function DIV(opCode, AC, effectiveAddress) {
    "use strict";
    var operand, oSign, rSign, remainder, doubleWord;
    if ((operand = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
        if (operand < wordSign) {
            oSign = 1;
        } else {
            oSign = -1;
            operand = wordBase - operand;
        }
        if (!operand) {
            setFlags(flagAOV | flagTR1 | flagDCX); // Division by zero
        } else {
            remainder = [CPU.accumulator[AC], CPU.accumulator[nextAC(AC)]];
            rSign = getSignDoubleInt(remainder);
            if (remainder[0] >= operand) {
                setFlags(flagAOV | flagTR1 | flagDCX); // Overflow
            } else {
                remainder = toBase18Double(remainder);
                doubleWord = [];
                fromBase18(doubleWord, divideWords(remainder, toBase18Single(operand), halfBase, 0), oSign * rSign);
                if (writeResult(doubleWord[1]) >= 0) {
                    if ((opCode & 0x3) != 2) {
                        fromBase18(doubleWord, remainder, rSign);
                        CPU.accumulator[nextAC(AC)] = doubleWord[1];
                    }
                }
            }
        }
    }
}

// ASH Single word arithmetic shift

function ASH(opCode, AC, effectiveAddress) {
    "use strict";
    var src, dst, sign;
    src = effectiveAddress;
    dst = CPU.accumulator[AC];
    if (dst) {
        if (src < halfSign) { // Arithmetic shift left
            src = Math.min(src, 35);
            if (src) {
                sign = Math.trunc(dst / power2(35 - src)); // Bits which move through sign
                if (sign && sign != (power2(src + 1) - 1)) {
                    setFlags(flagAOV | flagC0); // Set AOV, C0
                }
                sign = 0;
                if (dst >= wordSign) {
                    sign = wordSign;
                }
                dst = sign + (dst % power2(35 - src)) * power2(src);
            }
        } else { // Arithmetic shift right
            src = Math.min(halfBase - src, 35);
            if (src) {
                if (dst >= wordSign) { // Sign bit set
                    sign = wordBase - power2(36 - src); // Compute shifted in sign bits
                    dst = sign + Math.trunc(dst / power2(src)); // Shift
                } else {
                    dst = Math.trunc(dst / power2(src)); // Shift without sign
                }
            }
        }
        CPU.accumulator[AC] = dst;
    }
}

// ASHC Double word arithmetic shift

function ASHC(opCode, AC, effectiveAddress) {
    "use strict";
    var src, dst, dst2, sign, data;
    src = effectiveAddress;
    dst = CPU.accumulator[AC];
    dst2 = CPU.accumulator[nextAC(AC)];
    if (src && (dst || dst2)) {
        sign = 0;
        if (dst >= wordSign) {
            sign = wordSign;
        }
        if (src < halfSign) { // Arithmetic double shift left
            src = Math.min(src, 71);
            if (src < 36) {
                data = Math.trunc(dst / power2(35 - src)); // Bits which move through sign
                if (data && data != (power2(src + 1) - 1)) {
                    setFlags(flagAOV | flagC0); // Set AOV, C0
                }
                dst = sign + (dst % power2(35 - src)) * power2(src) + Math.trunc((dst2 % wordSign) / power2(35 - src));
                dst2 = sign + (dst2 % power2(35 - src)) * power2(src);
            } else {
                data = Math.trunc(dst2 / power2(71 - src)); // Bits which move through sign
                if ((dst || data) && (dst != wordBase - 1 || data != (power2(36 - src) - 1))) {
                    setFlags(flagAOV | flagC0); // Set AOV, C0
                }
                dst = sign + (dst2 % power2(71 - src)) * power2(src);
                dst2 = 0;
            }
        } else { // Arithmetic double shift right
            src = Math.min(halfBase - src, 71);
            if (src) {
                if (src < 36) {
                    dst2 = sign + (dst % power2(src)) * power2(35 - src) + Math.trunc((dst2 % wordSign) / power2(src));
                    if (sign) {
                        dst = wordBase - power2(36 - src) + Math.trunc(dst / power2(src)); // Shift
                    } else {
                        dst = Math.trunc(dst / power2(src)); // Shift without sign
                    }
                } else {
                    dst2 = sign + Math.trunc(dst / power2(src - 35));
                    if (sign) {
                        dst = wordBase - 1;
                    } else {
                        dst = 0;
                    }
                }
            }
        }
        CPU.accumulator[AC] = dst;
        CPU.accumulator[nextAC(AC)] = dst2;
    }
}

// ROTC double word rotate out one end into the other

function ROTC(opCode, AC, effectiveAddress) {
    "use strict";
    var src, dst, dst2, data;
    src = effectiveAddress;
    dst = CPU.accumulator[AC];
    dst2 = CPU.accumulator[nextAC(AC)];
    if (dst || dst2) {
        if (src < halfSign) {
            src %= 256;
            src %= 72;
        } else {
            src = (halfBase - src) % 256;
            if (!src) src = 256;
            src %= 72;
            if (src) {
                src = 72 - src;
            }
        }
        if (src) {
            if (src < 36) {
                data = (dst % power2(36 - src)) * power2(src) + Math.trunc(dst2 / power2(36 - src));
                dst2 = (dst2 % power2(36 - src)) * power2(src) + Math.trunc(dst / power2(36 - src));
                dst = data;
            } else {
                if (src == 36) {
                    data = dst;
                    dst = dst2;
                    dst2 = data;
                } else {
                    data = (dst2 % power2(72 - src)) * power2(src - 36) + Math.trunc(dst / power2(72 - src));
                    dst2 = (dst % power2(72 - src)) * power2(src - 36) + Math.trunc(dst2 / power2(72 - src));
                    dst = data;
                }
            }
            CPU.accumulator[AC] = dst;
            CPU.accumulator[nextAC(AC)] = dst2;
        }
    }
}

// LSHC double word zero fill shift

function LSHC(opCode, AC, effectiveAddress) {
    "use strict";
    var src, dst, dst2;
    src = effectiveAddress;
    dst = CPU.accumulator[AC];
    dst2 = CPU.accumulator[nextAC(AC)];
    if (src && (dst || dst2)) {
        if (src < halfSign) { // Double word shift left
            if (src >= 36) {
                if (src >= 72) {
                    dst = 0;
                } else {
                    dst = (dst2 % power2(72 - src)) * power2(src - 36);
                }
                dst2 = 0;
            } else {
                dst = (dst % power2(36 - src)) * power2(src) + Math.trunc(dst2 / power2(36 - src));
                dst2 = (dst2 % power2(36 - src)) * power2(src);
            }
        } else { // Double word shift right
            src = halfBase - src;
            if (src >= 36) {
                if (src >= 72) {
                    dst2 = 0;
                } else {
                    dst2 = Math.trunc(dst / power2(src - 36));
                }
                dst = 0;
            } else {
                dst2 = (dst % power2(src)) * power2(36 - src) + Math.trunc(dst2 / power2(src));
                dst = Math.trunc(dst / power2(src));
            }
        }
        CPU.accumulator[AC] = dst;
        CPU.accumulator[nextAC(AC)] = dst2;
    }
}

// Unimplemented opCode
function UUO(opCode, AC, effectiveAddress, trapFlag) {
    "use strict";
    var trapAddress, operand, instruction;
    if (opCode >= 1 && opCode <= 0o37) { // LUUO
        if (!CPU.userMode) { // Exec LUUOs are in Exec process table - of course they are! :-(
            if (writeWordToExecTable(0o40, opCode * BIT8 + AC * BIT12 + effectiveAddress) >= 0) {
                XCT(readWordFromExecTable(0o41), 0); // Execute 041 from exec table
            }
        } else {
            if (writeWordByVirtual(0o40, opCode * BIT8 + AC * BIT12 + effectiveAddress) >= 0) {
                if ((instruction = getWordByVirtual(0o41, accessRead | accessExecute)) >= 0) {
                    XCT(instruction, 0); // Execute 041 from current virtual space
                }
            }
        }
    } else { // MUUO - KI10 simply reads a new flag word - no funny flag manipulation required
        writeWordToUserTable(0o424, opCode * BIT8 + AC * BIT12 + effectiveAddress);
        writeWordToUserTable(0o425, getPCword());
        trapAddress = 0o430; // Base for 8 possible new MUUO PC words...
        if (CPU.userMode) { // If kernel vs user mode...
            trapAddress += 4;
        }
        if (inPublicMode()) { // If super vs public mode...
            trapAddress += 2;
        }
        if (trapFlag) { // If an instruction trap...
            trapAddress += 1;
        }
        if ((operand = readWordFromUserTable(trapAddress)) >= 0) {
            writeFlags(left(operand));
            jump(right(operand));
            CPU.interruptMode = 0; // PUSHJ, JSP, JSR & MMUO hold the interrupt level
        }
    }
}

function getEffectiveAddress(effectiveAddress) { // Effective address calculations ignores PXCT flags
    "use strict";
    var level, saveAddress;
    for (level = 0; effectiveAddress & 0o37000000;) { // Check for indexing or indirection
        saveAddress = effectiveAddress;
        if (saveAddress & 0o17000000) { // Do any indexing...
            effectiveAddress = CPU.accumulator[(effectiveAddress >>> 18) & 0xf];
            effectiveAddress = combine(left(effectiveAddress), effectiveAddress + saveAddress);
        }
        if (!(saveAddress & 0o20000000)) { // Is indirection set?
            break; // No - done!
        } else {
            if (++level > 1024) { // Limit number of indirection levels...
                CPU.PC = CPU.savePC; // Give up
                return -1;
            }
            if ((effectiveAddress = getWordByVirtual(right(effectiveAddress), accessRead)) < 0) { // No PXCT
                return effectiveAddress; // Error return failed read
            }
        }
    }
    return effectiveAddress;
}

// If the paging hardware cannot make the desired memory reference it terminates
// the instruction immediately without disturbing memory, the accumulators or the PC!
// XCT() execute an instruction
function XCT(instruction, trapFlag) {
    "use strict";
    var effectiveFlags, effectiveAddress, opCode, AC, src, dst, data;
    CPU.instructionLights = instruction; // for panel lights
    if ((effectiveFlags = getEffectiveAddress(instruction)) >= 0) { // Must ignore PXCT flags
        effectiveAddress = right(effectiveFlags);
        opCode = Math.trunc(instruction / BIT8);
        AC = (instruction >>> 23) & 0xf;

        switch (opCode >>> 6) { // break up switch into 8 subunits of 64 instructions each
            case 0: // 000-077: Unimplemented User Operations
                //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "UUO");
                UUO(opCode, AC, effectiveAddress, trapFlag);
                break;
            case 1: // 100-177: Floating point and Byte manipulation
                fpp10(instruction, AC, effectiveAddress, opCode); // see fp10.js
                break;
            case 2: // 200-277: Fixed point instructions
                switch (opCode) {
                    case 0o200: // MOVE  C(AC) <- C(E)
                    case 0o201: // MOVEI C(AC) <- 0,,E
                    case 0o202: // MOVEM C(E)  <- C(AC)
                    case 0o203: // MOVES C(E)  <- C(E); if AC#0 then C(AC) <- C(E)
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "MOVE" + operationName[opCode & 0x3]);
                        if ((src = readWordForMove(opCode, AC, effectiveAddress)) >= 0) {
                            writeResult(src);
                        }
                        break;
                    case 0o204: // MOVS  C(AC) <- CS(E)
                    case 0o205: // MOVSI C(AC) <- E,,0
                    case 0o206: // MOVSM C(E)  <- CS(AC)
                    case 0o207: // MOVSS C(E)  <- CS(E); if AC#0 then C(AC) <- CS(E)
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "MOVS" + operationName[opCode & 0x3]);
                        if ((src = readWordForMove(opCode, AC, effectiveAddress)) >= 0) {
                            writeResult(combine(right(src), left(src))); // swap halves
                        }
                        break;
                    case 0o210: // MOVN  C(AC) <- -C(E)
                    case 0o211: // MOVNI C(AC) <- -E
                    case 0o212: // MOVNM C(E)  <- -C(AC)
                    case 0o213: // MOVNS C(E)  <- -C(E); if AC#0 then C(AC) <- -C(E)
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "MOVN" + operationName[opCode & 0x3]);
                        if ((dst = readWordForMove(opCode, AC, effectiveAddress)) >= 0) {
                            if (dst) {
                                dst = wordBase - dst;
                            }
                            if (writeResult(dst) >= 0) {
                                if (dst == wordSign) {
                                    setFlags(flagTR1 | flagAOV | flagC1); // Set TR1, AOV, C1
                                } else {
                                    if (!dst) {
                                        setFlags(flagC0 | flagC1); // Set C0, C1
                                    }
                                }
                            }
                        }
                        break;
                    case 0o214: // MOVM  C(AC) <- |C(E)|
                    case 0o215: // MOVMI C(AC) <- 0,,E
                    case 0o216: // MOVMM C(E)  <- |C(AC)|
                    case 0o217: // MOVMS C(E)  <- |C(E)|; if AC#0 then C(AC) <- |C(E)|
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "MOVM" + operationName[opCode & 0x3]);
                        if ((dst = readWordForMove(opCode, AC, effectiveAddress)) >= 0) {
                            if (dst >= wordSign) {
                                dst = wordBase - dst;
                            }
                            if (writeResult(dst) >= 0) {
                                if (dst == wordSign) {
                                    setFlags(flagTR1 | flagAOV | flagC1); // Set TR1, AOV, C1
                                }
                            }
                        }
                        break;
                    case 0o220: // IMUL  C(AC) <- C(AC) * C(E);
                    case 0o221: // IMULI C(AC) <- C(AC) * E;
                    case 0o222: // IMULM C(E)  <- C(AC) * C(E);
                    case 0o223: // IMULB C(AC) <- C(AC) * C(E);  C(E) <- C(AC);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "IMUL" + operationName[opCode & 0x3]);
                        IMUL(opCode, AC, effectiveAddress);
                        break;
                    case 0o224: // MUL  C(AC,AC+1) <- C(AC) * C(E);
                    case 0o225: // MULI C(AC,AC+1) <- C(AC) * E;
                    case 0o226: // MULM C(E)  <- high word of product of C(AC) * C(E);
                    case 0o227: // MULB C(AC,AC+1) <- C(AC) * C(E);  C(E) <- C(AC);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "MUL" + operationName[opCode & 0x3]);
                        MUL(opCode, AC, effectiveAddress);
                        break;
                    case 0o230: // IDIV  C(AC) <- C(AC) / C(E);  C(AC+1) <- remainder
                    case 0o231: // IDIVI C(AC) <- C(AC) / E;  C(AC+1) <- remainder;
                    case 0o232: // IDIVM C(E)  <- C(AC) / C(E);
                    case 0o233: // IDIVB C(AC) <- C(AC) / C(E);  C(AC+1) <- remainder; C(E) <- C(AC);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "IDIVB" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = fromInteger(CPU.accumulator[AC]);
                            if (src == 0) { // || Math.abs(src) > Math.abs(dst)) { // divide by zero or divisor bigger than dividend
                                setFlags(flagAOV | flagDCX); // Set AOV, DCX
                            } else {
                                if (writeResult(toInteger(Math.trunc(dst / fromInteger(src)))) >= 0) {
                                    if ((opCode & 0x3) != 2) {
                                        CPU.accumulator[nextAC(AC)] = toInteger(dst % fromInteger(src));
                                    }
                                }
                            }
                        }
                        break;
                    case 0o234: // DIV  C(AC) <- C(AC,AC+1) / C(E); C(AC+1) <- remainder;
                    case 0o235: // DIVI C(AC) <- C(AC,AC+1) / E;    C(AC+1) <- remainder;
                    case 0o236: // DIVM C(E)  <- C(AC,AC+1) / E;
                    case 0o237: // DIVB C(AC) <- C(AC,AC+1) / C(E); C(AC+1) <- remainder; C(E) <- C(AC);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "DIVB" + operationName[opCode & 0x3]);
                        DIV(opCode, AC, effectiveAddress);
                        break;
                    case 0o240: // ASH  shift retaining sign bit
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ASH");
                        ASH(opCode, AC, effectiveAddress);
                        break;
                    case 0o241: // ROT  rotate out of one end into the other
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ROT");
                        src = effectiveAddress;
                        dst = CPU.accumulator[AC];
                        if (dst) {
                            if (src < halfSign) {
                                src %= 256;
                                src %= 36;
                            } else {
                                src = (halfBase - src) % 256;
                                if (!src) src = 256;
                                src %= 36;
                                if (src) {
                                    src = 36 - src;
                                }
                            }
                            if (src) {
                                data = power2(36 - src);
                                dst = (dst % data) * power2(src) + Math.trunc(dst / data);
                                CPU.accumulator[AC] = dst;
                            }
                        }
                        break;
                    case 0o242: // LSH  zero fill shift
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "LSH");
                        src = effectiveAddress;
                        dst = CPU.accumulator[AC];
                        if (src && dst) {
                            if (src < halfSign) { // Shift left
                                if (src >= 36) {
                                    dst = 0;
                                } else {
                                    dst = (dst % power2(36 - src)) * power2(src);
                                }
                            } else { // Shift right
                                src = halfBase - src;
                                if (src >= 36) {
                                    dst = 0;
                                } else {
                                    dst = Math.trunc(dst / power2(src));
                                }
                            }
                            CPU.accumulator[AC] = dst;
                        }
                        break;
                    case 0o243: // JFFO  Jump if Find First One.
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JFFO");
                        dst = 0;
                        src = CPU.accumulator[AC];
                        if (src) {
                            jump(effectiveAddress);
                            while (src < wordSign) {
                                dst++;
                                src *= 2;
                            }
                        }
                        CPU.accumulator[nextAC(AC)] = dst;
                        break;
                    case 0o244: // ASHC double word shift retaining sign bit(s)
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ASHC");
                        ASHC(opCode, AC, effectiveAddress);
                        break;
                    case 0o245: // ROTC double word rotate out one end into the other
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ROTC");
                        ROTC(opCode, AC, effectiveAddress);
                        break;
                    case 0o246: // LSHC double word zero fill shift
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "LSHC");
                        LSHC(opCode, AC, effectiveAddress);
                        break;
                    case 0o247: // (247) do UUO unimplemented on KI10
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "(247)");
                        UUO(opCode, AC, effectiveAddress, 0);
                        break;
                    case 0o250: // EXCH C(AC)><C(E)
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "EXCH");
                        if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
                            if (writeWordByVirtual(effectiveAddress, CPU.accumulator[AC]) >= 0) {
                                CPU.accumulator[AC] = src;
                            }
                        }
                        break;
                    case 0o251: // BLT block transfer
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "BLT");
                        data = CPU.accumulator[AC];
                        src = left(data);
                        dst = right(data);
                        do {
                            if ((data = readWordByVirtual(src)) < 0) {
                                CPU.accumulator[AC] = combine(src, dst);
                                break;
                            }
                            if (writeWordByVirtual(dst, data) < 0) {
                                CPU.accumulator[AC] = combine(src, dst);
                                break;
                            }
                            src++;
                            dst++;
                        } while (dst <= effectiveAddress);
                        break;
                    case 0o252: // AOBJP C(AC)<-C(AC)+<1,,1>; If C(AC)>=0 then PC<-E;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "AOBJP");
                        src = CPU.accumulator[AC];
                        dst = combine(left(src) + 1, right(src) + 1);
                        CPU.accumulator[AC] = dst;
                        if (dst < wordSign) {
                            jump(effectiveAddress);
                        }
                        break;
                    case 0o253: // AOBJN C(AC)<-C(AC)+<1,,1>; If C(AC)<0 then PC<-E;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "AOBJN");
                        src = CPU.accumulator[AC];
                        dst = combine(left(src) + 1, right(src) + 1);
                        CPU.accumulator[AC] = dst;
                        if (dst >= wordSign) {
                            jump(effectiveAddress);
                        }
                        break;
                    case 0o254: // JRST Jump and ReSTore  PC<-E; with options to clear public, restore flags, halt, or restore channel
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JRST");
                        if (CPU.interruptMode) { // For interrupt PUSHJ, JSP & JSR clear USR & PUB while JSA & JRST clear USR
                            clearFlags(flagUSR);
                        }
                        if (AC & (8 | 4) && !ifPrivilege()) {
                            UUO(opCode, AC, effectiveAddress, 0);
                        } else {
                            if (AC & 8) { // Restore channel
                                releaseHiInterrupt();
                            }
                            if (AC & 4) { // Halt processor
                                console.log("HALT @" + CPU.PC.toString(8));
								CPU.miscLights |= 8; // Turn on STOP PROG light
								CPU.miscLights &= ~2; // Turn off RUN light
                                CPU.halt = 1;
                                CPU.loopCount = -1;
                            }
                            if (AC & 2) { // Restore flags AOV C0  C1  FOV FPD USR IOT PUB AFI TR2 TR1 FXU DCX 0 0 0 0 0
                                src = left(effectiveFlags);
                                if (!ifPrivilege()) { // TEST
                                    src |= CPU.flags & (flagUSR | flagPUB); // Keep user & public flags if set
                                    if (!(CPU.flags & flagIOT)) src &= ~flagIOT;
                                }
                                writeFlags(src);
                            }
                            if (AC & 1) { // Clear Public mode
                                CPU.flags &= ~flagPUB; // Clear PUB (KA10 different)
                            }
                            jump(effectiveAddress);
                        }
                        break;
                    case 0o255: // JFCL Jump conditional on AROV, CRY0, CRY1, and/or FOV
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JFCL");
                        src = AC << 14;
                        if (CPU.flags & src) {
                            clearFlags(src);
                            jump(effectiveAddress);
                        }
                        break;
                    case 0o256: // XCT execute instruction
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "XCT");
                        if (CPU.PXCTflags) {
                            CPU.PXCTflags = 0; // PXCT calling an XCT can't PXCT
                        } else {
                            if (!CPU.userMode) {
                                CPU.PXCTflags = AC & 3; // Only kernel mode can PXCT
                            }
                        }
                        if ((instruction = getWordByVirtual(effectiveAddress, accessRead | accessExecute)) >= 0) {
                            XCT(instruction, 0); // Note recursion...
                        }
                        CPU.PXCTflags = 0;
                        break;
                    case 0o257: // MAP Put page map data for effective address in AC right
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "MAP");
                        pag.coniStatus = (pag.coniStatus & ~0x1f) | ((pag.coniStatus + 1) & 0x1f); // Increment reload
                        CPU.accumulator[AC] = getVirtualMap(effectiveAddress, accessWrite | CPU.PXCTflags); // Dummy map - assume write
                        break;
                    case 0o260: // PUSHJ C(AC)<-C(AC)+<1,,1>;  C(CR(AC))<-<flags,,PC>; PC<-E;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "PUSHJ");
                        src = getPCword();
                        if (CPU.interruptMode) { // For interrupt PUSHJ, JSP & JSR clear USR & PUB while JSA & JRST clear USR
                            clearFlags(flagUSR | flagPUB);
                            CPU.interruptMode = 0; // PUSHJ, JSP, JSR & MMUO hold the interrupt level
                        }
                        dst = combine(left(CPU.accumulator[AC]) + 1, right(CPU.accumulator[AC]) + 1);
                        if (writeWordByVirtual(right(dst), src) >= 0) {
                            CPU.accumulator[AC] = dst;
                            clearFlags(flagFPD | flagAFI | flagTR2 | flagTR1); // Turn off FPD, etc
                            jump(effectiveAddress);
                            if (!left(dst)) {
                                setFlags(flagTR2);
                            }
                        }
                        break;
                    case 0o261: // PUSH C(AC)<-C(AC)+<1,,1>;  C(CR(AC))<-C(E)
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "PUSH");
                        if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
                            dst = incrAddress(left(CPU.accumulator[AC]));
                            if (!dst) {
                                setFlags(flagTR2);
                            }
                            dst = combine(dst, right(CPU.accumulator[AC]) + 1);
                            if (writeWordByVirtual(right(dst), src) >= 0) {
                                CPU.accumulator[AC] = dst;
                            }
                        }
                        break;
                    case 0o262: // POP C(E)<-C(CR(AC)); C(AC)<-C(AC)-<1,,1>
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "POP");
                        dst = CPU.accumulator[AC];
                        if ((src = readWordByVirtual(right(dst))) >= 0) {
                            if (writeWordByVirtual(effectiveAddress, src) >= 0) {
                                if (!left(dst)) {
                                    setFlags(flagTR2);
                                }
                                CPU.accumulator[AC] = combine(left(dst) - 1, right(dst) - 1);
                            }
                        }
                        break;
                    case 0o263: // POPJ PC<-CR(CR(AC)); C(AC)<-C(AC)-<1,,1>
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "POPJ");
                        dst = CPU.accumulator[AC];
                        if ((src = readWordByVirtual(right(dst))) >= 0) {
                            jump(right(src));
                            if (!left(dst)) {
                                setFlags(flagTR2);
                            }
                            CPU.accumulator[AC] = combine(left(dst) - 1, right(dst) - 1);
                        }
                        break;
                    case 0o264: // JSR C(E)<-<flags,,PC>; PC<-E+1;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JSR");
                        dst = getPCword();
                        if (CPU.interruptMode) { // For interrupt PUSHJ, JSP & JSR clear USR & PUB while JSA & JRST clear USR
                            clearFlags(flagUSR | flagPUB);
                            CPU.interruptMode = 0; // PUSHJ, JSP, JSR & MMUO hold the interrupt level
                        }
                        if (writeWordByVirtual(effectiveAddress, dst) >= 0) {
                            clearFlags(flagFPD | flagAFI | flagTR2 | flagTR1); // Turn off FPD, etc
                            jump(incrAddress(effectiveAddress));
                        }
                        break;
                    case 0o265: // JSP C(AC)<-<flags,,PC>; PC<-E;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JSP");
						CPU.accumulator[AC] = getPCword()
                        if (CPU.interruptMode) { // For interrupt PUSHJ, JSP & JSR clear USR & PUB while JSA & JRST clear USR
                            clearFlags(flagUSR | flagPUB);
                            CPU.interruptMode = 0; // PUSHJ, JSP, JSR & MMUO hold the interrupt level
                        }
                        clearFlags(flagFPD | flagAFI | flagTR2 | flagTR1); // Turn off FPD, etc
                        jump(effectiveAddress);
                        break;
                    case 0o266: // JSA C(E)<-C(AC); C(AC)<-<E,,PC>; PC<-E+1;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JSA");
                        if (CPU.interruptMode) { // For interrupt PUSHJ, JSP & JSR clear USR & PUB while JSA & JRST clear USR
                            clearFlags(flagUSR | flagPUB);
                        }
                        if (writeWordByVirtual(effectiveAddress, CPU.accumulator[AC]) >= 0) {
                            CPU.accumulator[AC] = combine(effectiveAddress, CPU.PC);
                            jump(effectiveAddress + 1);
                        }
                        break;
                    case 0o267: // JRA C(AC)<-C(CL(AC)); PC<-E;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JRA");
                        if ((src = readWordByVirtual(left(CPU.accumulator[AC]))) >= 0) {
                            CPU.accumulator[AC] = src;
                            jump(effectiveAddress);
                        }
                        break;
                    case 0o270: // ADD  C(AC) <- C(AC) + C(E);
                    case 0o271: // ADDI C(AC) <- C(AC) + E;
                    case 0o272: // ADDM C(E)  <- C(AC) + C(E);
                    case 0o273: // ADDB C(AC) <- C(AC) + C(E);  C(E) <- C(AC);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ADD" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            data = 0;
                            if ((dst % wordSign) + (src % wordSign) >= wordSign) {
                                data |= flagC0; // Will set C0
                            }
                            dst += src;
                            if (dst >= wordBase) {
                                dst -= wordBase;
                                data |= flagC1; // Will set C1
                            }
                            if (writeResult(dst) >= 0) {
                                if (data) {
                                    if (data != (flagC0 | flagC1)) {
                                        data |= flagAOV | flagTR1; // Set AOV and TR1 if only one carry set
                                    }
                                    setFlags(data);
                                }
                            }
                        }
                        break;
                    case 0o274: // SUB  C(AC) <- C(AC) - C(E);
                    case 0o275: // SUBI C(AC) <- C(AC) - E;
                    case 0o276: // SUBM C(E)  <- C(AC) - C(E);
                    case 0o277: // SUBB C(AC) <- C(AC) - C(E);  C(E) <- C(AC);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SUB" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            data = 0;
                            if (src) {
                                src = wordBase - src; // Make src -ve for subtract
                                if ((dst % wordSign) + (src % wordSign) >= wordSign) {
                                    data |= flagC0; // Will set C0
                                }
                                dst += src;
                                if (dst >= wordBase) {
                                    dst -= wordBase;
                                    data |= flagC1; // Will set C1
                                }
                            }
                            if (writeResult(dst) >= 0) {
                                if (data) {
                                    if (data != (flagC0 | flagC1)) {
                                        data |= flagAOV | flagTR1; // Set AOV and TR1 if only one carry set
                                    }
                                    setFlags(data);
                                }
                            }
                        }
                        break;
                }
                break;
            case 3: // 300-377: Hop, skip and jump instructions
                switch (opCode & 0x1f8) {
                    case 0o300: // CAI Compare Accumulator Immediate
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "CAI" + conditionName[opCode & 0x7]);
                        skipTest(opCode, compareWord(CPU.accumulator[AC], effectiveAddress));
                        break;
                    case 0o310: // CAM Compare Accumulator to Memory
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "CAM" + conditionName[opCode & 0x7]);
                        if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
                            skipTest(opCode, compareWord(CPU.accumulator[AC], src));
                        }
                        break;
                    case 0o320: // JUMP test accumulator and jump
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "JUMP" + conditionName[opCode & 0x7]);
                        branchTest(opCode, CPU.accumulator[AC], effectiveAddress);
                        break;
                    case 0o330: // SKIP compare contents of effective address to zero and skip
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SKIP" + conditionName[opCode & 0x7]);
                        if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
                            skipTestSpecial(opCode, src);
                            if (AC) {
                                CPU.accumulator[AC] = src;
                            }
                        }
                        break;
                    case 0o340: // AOJ C(AC) <- C(AC)+1;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "AOJ" + conditionName[opCode & 0x7]);
                        branchTest(opCode, CPU.accumulator[AC] = incrementWord(CPU.accumulator[AC]), effectiveAddress);
                        break;
                    case 0o350: // AOS C(E) <- C(E)+1;  If AC#0 then C(AC)<-C(E);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "AOS" + conditionName[opCode & 0x7]);
                        if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
                            dst = incrementWord(src); // Increment
                            if (writeWordByVirtual(effectiveAddress, dst) >= 0) {
                                skipTestSpecial(opCode, dst);
                                if (AC) {
                                    CPU.accumulator[AC] = dst;
                                }
                            }
                        }
                        break;
                    case 0o360: // SOJ C(AC) <- C(AC)-1;
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SOJ" + conditionName[opCode & 0x7]);
                        branchTest(opCode, CPU.accumulator[AC] = decrementWord(CPU.accumulator[AC]), effectiveAddress);
                        break;
                    case 0o370: // SOS C(E) <- C(E)-1;  If AC#0 then C(AC)<-C(E);
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SOS" + conditionName[opCode & 0x7]);
                        if ((src = readWordByVirtual(effectiveAddress)) >= 0) {
                            dst = decrementWord(src); // Decrement
                            if (writeWordByVirtual(effectiveAddress, dst) >= 0) {
                                skipTestSpecial(opCode, dst);
                                if (AC) {
                                    CPU.accumulator[AC] = dst;
                                }
                            }
                        }
                        break;
                }
                break;
            case 4: // 400-477: Logical operations.
                switch (opCode & 0x1fc) {
                    case 0o400: // SETZ SET to Zero
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SETZ" + operationName[opCode & 0x3]);
                        writeWordByOperand(opCode, 0, AC, effectiveAddress);
                        break;
                    case 0o404: // AND AND
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "AND" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(left(src) & left(dst), right(src) & right(dst)));
                        }
                        break;
                    case 0o410: // ANDCA AND with Complement of AC
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ANDCA" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(left(src) & ~left(dst), right(src) & ~right(dst)));
                        }
                        break;
                    case 0o414: // SETM SET to Memory
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SETM" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            writeResult(src);
                        }
                        break;
                    case 0o415: // SETMI (XMOVEI)  C(AC) <- 0,,E
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SETMI" + operationName[opCode & 0x3]);
                        CPU.accumulator[AC] = effectiveAddress;
                        break;
                    case 0o420: // ANDCM AND with Complement of Memory
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ANDCM" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(~left(src) & left(dst), ~right(src) & right(dst)));
                        }
                        break;
                    case 0o424: // SETA SET to AC
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SETA" + operationName[opCode & 0x3]);
                        writeWordByOperand(opCode, CPU.accumulator[AC], AC, effectiveAddress);
                        break;
                    case 0o430: // XOR eXclusive OR
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "XOR" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(left(src) ^ left(dst), right(src) ^ right(dst)));
                        }
                        break;
                    case 0o434: // OR Inclusive OR
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "OR" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(left(src) | left(dst), right(src) | right(dst)));
                        }
                        break;
                    case 0o440: // ANDCB AND with Complements of Both
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ANDCB" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(~left(src) & ~left(dst), ~right(src) & ~right(dst)));
                        }
                        break;
                    case 0o444: // EQV EQuiValence
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "EQV" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(~(left(src) ^ left(dst)), ~(right(src) ^ right(dst))));
                        }
                        break;
                    case 0o450: // SETCA SET to Complement of AC
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SETCA" + operationName[opCode & 0x3]);
                        dst = CPU.accumulator[AC];
                        writeWordByOperand(opCode, combine(~left(dst), ~right(dst)), AC, effectiveAddress);
                        break;
                    case 0o454: // ORCA OR with Complement of AC
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ORCA" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(left(src) | ~left(dst), right(src) | ~right(dst)));
                        }
                        break;
                    case 0o460: // SETCM SET to Complement of Memory
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SETCM" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            writeResult(combine(~left(src), ~right(src)));
                        }
                        break;
                    case 0o464: // ORCM OR with Complement of Memory
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ORCM" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(~left(src) | left(dst), ~right(src) | right(dst)));
                        }
                        break;
                    case 0o470: // ORCB OR with Complements of Both
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "ORCB" + operationName[opCode & 0x3]);
                        if ((src = readWordForOperand(opCode, AC, effectiveAddress)) >= 0) {
                            dst = CPU.accumulator[AC];
                            writeResult(combine(~left(src) | ~left(dst), ~right(src) | ~right(dst)));
                        }
                        break;
                    case 0o474: // SETO SET to One
                        //LOG_INSTRUCTION(instruction, AC, effectiveAddress, "SETO" + operationName[opCode & 0x3]);
                        writeWordByOperand(opCode, wordMask, AC, effectiveAddress);
                        break;
                }
                break;
            case 5: // 500-577: Half-word operations
                // HLL and it's 63 friends
                //LOG_INSTRUCTION(instruction, AC, effectiveAddress, halfWordNames[opCode & 0x3f]);
                halfWord(opCode, AC, effectiveAddress);
                break;
            case 6: // 600-677: Bit testing
                // TRN and it's 63 friends
                //LOG_INSTRUCTION(instruction, AC, effectiveAddress, bitTestNames[opCode & 0x3f]);
                bitTest(opCode, AC, effectiveAddress);
                break;
            case 7: // 700-777: Input/Output
                ioOperation(instruction, AC, effectiveAddress, opCode);
                break;
        }
    }
}

// main() executes forever. It executes a batch of instructions and then schedules itself to run again.

function main() {
    "use strict";
    var loopTime, instruction;
    if (!CPU.halt) {
        loopTime = Date.now();
        for (CPU.loopCount = CPU.loopBase; CPU.loopCount > 0; --CPU.loopCount) {
            if (CPU.checkInterruptFlag) {
                checkInterrupt();
            }
            if ((CPU.flags & flagTR3) && CPU.pageEnable) {
				instruction = readWordFromCurrentTable(0o420 + ((CPU.flags & flagTR3) >>> 7));
				CPU.flags &= ~flagTR3;
				XCT(instruction, 1); // Execute trap instruction
            } else {
				CPU.savePC = CPU.PC; // Save PC at instruction start in case of pagefail
				CPU.PC = incrAddress(CPU.PC); 
				if ((instruction = getWordByVirtual(CPU.savePC, accessRead | accessExecute)) >= 0) {
					XCT(instruction, 0); // Execute instruction at PC
				}
			}
        }
        if (!CPU.halt) {
            if (!CPU.loopPause) {
                loopTime = Date.now() - loopTime; // Compute time taken to execute loopBase instructions
                if (loopTime < 6) {
                    CPU.loopBase += Math.trunc(CPU.loopBase / 8); // Ideally we want loopTime to be about 8ms
                } else {
                    if (loopTime > 9) {
                        CPU.loopBase = Math.max(72, Math.trunc(CPU.loopBase * 8 / loopTime));
                    }
                }
                setTimeout(main, 3);
            }
        }
    }
}