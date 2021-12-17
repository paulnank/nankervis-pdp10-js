// Javascript emulation code for the IO system and devices in a DECsystem-10 (PDP-10 KI10) 
// See https://skn.noip.me/pdp10/pdp10.html for more information


var DEBUG = 0;
const
    IO_BLOCKSIZE = 1024 * 1024; // 1 Mb request size. Larger reduces number of requests but increases count

// =========== Disk I/O support routines ===========

// extractXHR() copies the XMLHttpRequest response to disk cache returning
// 0 on success or -1 on error

function extractXHR(xhr, cache, block) {
    "use strict";
    var dataView, dataLength, dataIndex, blockIndex;
    switch (xhr.status) {
        case 416: // Out of range - make empty cache block
            dataLength = 0;
            break;
        case 200: // Whole file response - fill cache from beginning
            block = 0; // Note case fall thru!
        case 0: // Local response - have to assume we got appropriate response
        case 206: // Partial response - use what is there
            dataView = new Uint8Array(xhr.response);
            dataLength = dataView.length;
            break;
        default: // Error - signal and exit
            return -1; // Return error
    }

    dataIndex = 0; // Start copy to cache at the beginning
    do {
        if (typeof cache[block] === "undefined") {
            cache[block] = new Uint8Array(IO_BLOCKSIZE); // Creates zero filled cache block
            for (blockIndex = 0; blockIndex < IO_BLOCKSIZE && dataIndex < dataLength;) {
                cache[block][blockIndex++] = dataView[dataIndex++] & 0xff;
            }
        } else {
            dataIndex += IO_BLOCKSIZE; // Skip any existing cache blocks
        }
        block++;
    } while (dataIndex < dataLength);

    return 0; // Return success
}

// getData() is called at the completion of an XMLHttpRequest request to GET disk data.
// It extracts the received data and stores it in the appropriate disk cache, then resumes
// the pending IO (which may trigger more transfers).

function getData(xhr, operation, controller, drive, position, address, count) {
    "use strict";
    if (extractXHR(xhr, controller.unit[drive].cache, ~~(position / IO_BLOCKSIZE)) < 0) {
        controller.postProcess(1, controller, drive, position, address, count); // NXD - invoke error callback
    } else {
        diskIO(operation, controller, drive, position, address, count, 0); // Resume I/O
    }
}

// diskIO() moves data between memory and the device cache. If cache blocks are undefined then
// an XMLHttpRequest request is kicked off to get the appropriate device data from the server.
// Operations supported are:  1: Write, 2: Read, 3: Check (corresponds with RK function codes :-) )
// address/count unused for pdp10 disk operations (buffer address/length are managed by control word structure)

function diskIO(operation, controller, drive, position, address, count, delay) {
    "use strict";
    var block, offset, cache, data, i, xhr;
            if (delay) {
                CPU.loopPause = 1; // Pause CPU loop to avoid disk timeouts
                //CPU.loopCount = 32; // Don't allow too many instructions until pause
            }
    block = ~~(position / IO_BLOCKSIZE); // Determine appropriate cache block
    offset = position % IO_BLOCKSIZE; // and initial offset
    while (count > 0) {
        cache = controller.unit[drive].cache[block];
        if (typeof cache === "undefined") { // If block not in cache request it...
            controller.xhr = xhr = new XMLHttpRequest();
            xhr.open("GET", controller.unit[drive].url, true);
            xhr.responseType = "arraybuffer";
            xhr.onreadystatechange = function() {
                if (xhr.readyState == xhr.DONE) {
                    getData(xhr, operation, controller, drive, position, address, count);
                }
            };
            xhr.setRequestHeader("Range", "bytes=" + (block * IO_BLOCKSIZE) + "-" + ((block + 1) * IO_BLOCKSIZE - 1));
            xhr.send(null);
            return; // Will resume via xhr callback when data arrives
        }
        if (delay) { // If delay requested but none encountered...
            setTimeout(diskIO, 1, operation, controller, drive, position, address, count, 0);
            CPU.loopCount = 32; // Guarantee some instructions before I/O
            return;
        }
        while (count > 0 && offset < IO_BLOCKSIZE) {
            switch (operation) {
                case 0: // Get a 4 byte tape record length (2 bytes at a time)
                    data = (cache[offset + 1] << 8) | cache[offset];
                    if (count > 1) {
                        controller.unit[drive].recordLen = data;
                        count = 1;
                    } else {
                        controller.unit[drive].recordLen |= data << 16;
                        count = 0;
                    }
                    offset += 2;
                    break;
                case 1: // Disk write: write to disk cache from memory (don't need address or count)
                case 3: // Disk compare: compare memory with disk cache
                    if ((address = getBufferAddress(controller)) < 0) { // Get next buffer address
                        count = -1; // Finish if no more addresses
                        break;
                    }
                    if ((data = readWordByPhysical(address)) < 0) { // Read memory word
                        controller.postProcess(2, controller, drive, block * IO_BLOCKSIZE + offset, address, count);
                        return; // NXM abort
                    }
                    for (i = 0; i < 8; i++) { // Data in disk cache: 36bits in 8 byte (64 bits) simh format
                        if (operation == 1) { // Write: write from memory to cache
                            cache[offset + i] = data % 256;
                        } else { // Check: compare memory with disk cache
                            if (data % 256 != cache[offset + i]) { // compare memory with disk cache
                                controller.postProcess(3, controller, drive, block * IO_BLOCKSIZE + offset, address, count);
                                return; // Compare abort
                            }
                        }
                        data = Math.trunc(data / 256);
                    }
                    offset += 8; // simh format uses 64 bits for each word
                    break;
                case 2: // Disk read: read into memory from disk cache (don't need address or count)
                    if ((address = getBufferAddress(controller)) < 0) { // Get next buffer address
                        count = -1; // Finish if no more addresses
                        break;
                    }
                    data = 0;
                    for (i = 4; i >= 0; i--) {
                        data = data * 256 + cache[offset + i];
                    }
                    if (writeWordByPhysical(address, data) < 0) { // Write to memory
                        controller.postProcess(2, controller, drive, block * IO_BLOCKSIZE + offset, address, count);
                        return; // NXM abort
                    }
                    offset += 8; // simh format uses 64 bits for each word
                    break;
                case 4: // Tape read: read into memory words from tape byte cache (address is loaded at start of new word)
                case 5: // Tape compare: compare memory words with tape byte cache (count is remaining tape record length)
                    // There are 4 bytes per word unless using 5 byte coredump mode
                    // words may be partially filled if tape record length is short
                    // words may start at odd addresses and can cross cache boundaries (!!)
                    if ((i = controller.partialByte)) { // Check if any data from previous cache block
                        data = controller.partialData; // Yes, start with that
                    } else {
                        data = 0; // At start of a new word get an address for it
                        if ((address = getBufferAddress(controller)) < 0) { // Get next buffer address
                            count = -1; // Finish if no more addresses
                            break;
                        }
                    }
                    for (; i < 4 && offset < IO_BLOCKSIZE; i++) { // Load first 4 bytes
                        data *= 256;
                        if (count > 0) { // Consume byte data if inside tape record length
                            data += cache[offset++];
                            count--;
                        }
                    }
                    if (i < 4) { // If we didn't get 4 bytes remember where we got up to for next cache block
                        controller.partialByte = i;
                        controller.partialData = data;
                    } else {
                        if (controller.coredump && count > 0) { // Coredump format requires fifth byte
                            if (offset < IO_BLOCKSIZE) { // Is fifth byte available?
                                data = data * 16 + (cache[offset++] & 0xf); // Add 4 bits from fifth byte
                                count--;
                            } else { // Fifth byte needed from next cache block, damn! :-(
                                controller.partialByte = 4;
                                controller.partialData = data;
                                break; // Bug out and get it later
                            }
                        } else {
                            data *= 16; //Shift the four bytes into position
                        } // OMG - we have assembled a word! Write/compare it quick.
                        if (operation == 4) { // Tape read
                            if (address > 0) { // Apparently a zero address means don't actually do the write
                                if (writeWordByPhysical(address, data) < 0) { // Write word to memory
                                    controller.postProcess(2, controller, drive, block * IO_BLOCKSIZE + offset, address, count);
                                    return; // NXM abort
                                }
                            }
                        } else { // Tape compare
                            if ((i = readWordByPhysical(address)) < 0) { // Read memory and check for error
                                controller.postProcess(2, controller, drive, block * IO_BLOCKSIZE + offset, address, count);
                                return; // NXM abort
                            }
                            if (i != data) { // Compare memory with data from tape
                                controller.postProcess(3, controller, drive, block * IO_BLOCKSIZE + offset, address, count);
                                return; // Compare abort
                            }
                        }
                        controller.partialByte = 0; // Clear any partial data
                    }
                    break;
                default:
                    panic(); // invalid operation - how did we get here?
            }
        }
        if (count > 0) { // If continuing step to next cache block...
            block++;
            offset = 0;
            position = block * IO_BLOCKSIZE;
        }
    }
    controller.postProcess(0, controller, drive, block * IO_BLOCKSIZE + offset, address, count); // success
    if (CPU.loopPause) {
        CPU.loopPause = 0; // End any slowdown for disk access
        main();
	}
}

// Need to follow a chain of control words to map I/O buffer addresses. Each control word
// contains a physical address and a word count. When the current word count expires step
// to the next control word. A control word containing zero means end of chain (terminating I/O).
// A control word count of zero means jump to a new control word location.
// Our implementation of this needs the controller variables:
//		.cwc 	;count of remaining locations at current address
//		.cda	;next I/O buffer address
//		.cwa	;next control word physical address
//		.in22Bit;flag to indicate if controller uses 18 or 22 bit physical addressing
// I/O starts by setting cwa to the supplied I/O icwa and setting cwc to zero to cause the icwa to be read.
function getBufferAddress(controller) {
    "use strict";
    var cw;
    while (controller.cwc == 0) { // Count = 0 means get next control word
        if ((cw = readWordByPhysical(controller.cwa)) < 0) {
            return cw;
        }
        if (cw == 0) {
            return -1; // No more control information - I/O complete
        }
        controller.cwa++; // Point to next control word
        if (controller.in22Bit) { // Is controller in 18 or 22 bit mode?
            controller.cwc = Math.trunc(cw / BIT13) & 0o37777; // 22 bit
            controller.cda = cw % BIT13;
        } else {
            controller.cwc = left(cw) & 0o37777; // 18 bit
            controller.cda = right(cw);
        }
        if (controller.cwc == 0) {
            controller.cwa = controller.cda; // branch in control word chain
        }
    }
    controller.cwc = (controller.cwc + 1) & 0o37777;
    controller.cda++;
    return controller.cda;
}

function releaseHiInterrupt() {
    "use strict";
    var mask;
    if (pi.coniStatus & BIT28) { // Do priority checks only if interrupts are enabled
        for (mask = BIT21; !(pi.coniStatus & mask); mask >>>= 1) {
            if (mask & BIT27) {
                mask = 0; // No highest level interrupt is uncomfortable!
                break;
            }
        }
        pi.coniStatus &= ~mask;
        CPU.checkInterruptFlag = 1;
        if (DEBUG && mask == BIT23) {
            console.log("End Interrupt  p:" + 3 + " tty.cs:" + tty.coniStatus.toString(8) + " lpt.cs:" + lpt.coniStatus.toString(8) + " pi:" + pi.coniStatus.toString(8) + " q:" + CPU.interruptQueue.length + " @" + CPU.PC.toString(8));
        }
    }
}

function interrupt(cleanFlag, delay, device, priority, callback, callarg) {
    "use strict";
    var i;
    if (typeof callback == "undefined") {
        callback = null;
    }
    if (cleanFlag) {
        for (i = CPU.interruptQueue.length; --i >= 0;) { // Remove any matching entries
            if (CPU.interruptQueue[i].device == device) {
                if (i > 0) {
                    CPU.interruptQueue[i - 1].delay += CPU.interruptQueue[i].delay;
                }
                CPU.interruptQueue.splice(i, 1);
                break;
            }
        }
    }
    priority &= 0x7;
    if (priority || (delay && callback)) {
        if (delay >= 0) { // delay below 0 doesn't create queue entry
            for (i = CPU.interruptQueue.length; --i >= 0;) { // Remove any matching entries
                if (CPU.interruptQueue[i].delay > delay) {
                    CPU.interruptQueue[i].delay -= delay;
                    break;
                }
                delay -= CPU.interruptQueue[i].delay;
            }
            CPU.interruptQueue.splice(i + 1, 0, {
                "delay": delay,
                "priority": priority,
                "device": device,
                "callback": callback,
                "callarg": callarg
            });
            if (DEBUG && (priority == 3 || device == deviceLPT)) {
                console.log("Queue Interrupt p:" + priority + " tty.cs:" + tty.coniStatus.toString(8) + " lpt.cs:" + lpt.coniStatus.toString(8) + " pi:" + pi.coniStatus.toString(8) + " q:" + CPU.interruptQueue.length + " dev:" + device + " delay:" + delay + " i:" + i + " @" + CPU.PC.toString(8));
            }
        }
    }
    CPU.checkInterruptFlag = 1;
}

function checkInterrupt() {
    "use strict";
    var i, mask, priority, highIndex, highMask;
    CPU.checkInterruptFlag = 0;
    highIndex = -2; // Flag to retain status quo!
    if (!(pi.coniStatus & BIT28)) { // Do priority checks only if interrupts are enabled
        highMask = 0x7f;
    } else {
        highMask = (pi.coniStatus >>> 8) & 0x7f; // Get current interrupts in progress
        mask = ((pi.coniStatus >>> 18) & ~highMask) & 0x7f; // Get pending program interrupts not in progress
        if (mask > highMask) { // If a pending program interrupt has higher than current priority...
            highIndex = -1; // Select program interrupt
            highMask = mask;
        }
    }
    for (i = CPU.interruptQueue.length; --i >= 0;) {
        if (CPU.interruptQueue[i].delay > 0) { // A non-zero delay count is end of loop
            CPU.checkInterruptFlag = 1; // And it requires a check next cycle as well
            if (--CPU.interruptQueue[i].delay == 0) { // Decrement by one delay and check if it became active
                do { // Do callbacks for any interrupts which just became active
                    if (CPU.interruptQueue[i].callback) { // If a callback for newly active interrupt...
                        if ((priority = CPU.interruptQueue[i].callback(CPU.interruptQueue[i].callarg)) >= 0) {
                            CPU.interruptQueue[i].priority = priority & 7;
                        }
                    }
                    if (CPU.interruptQueue[i].priority == 0) { // If zero priority delete entry
                        CPU.interruptQueue.splice(i, 1);
                        if (highIndex >= 0) {
                            highIndex--;
                        }
                    }
                } while (--i >= 0 && CPU.interruptQueue[i].delay == 0);
            }
            break; // If entry delayed then skip following delayed entries (exit)
        }
        mask = (BIT28 >>> CPU.interruptQueue[i].priority); // Priority mask for this queue entry
        if (pi.coniStatus & mask && mask > highMask) { // Is entry higher than so far selected priority and ready to go?
            highIndex = i; // Remember this queue entry
            highMask = mask;
        }
    }
    if (highIndex > -2) { // From that was there something to interrupt with?
        CPU.checkInterruptFlag = 1; // Recheck interrupts after this
        if (highIndex >= 0) { // Did interrupt come from device queue?
            priority = CPU.interruptQueue[highIndex].priority;
            CPU.interruptQueue.splice(highIndex, 1); // Remove from queue
        } else { // Must be program interrupt - compoute priority and ensure only one level of mask is set
            mask = highMask;
            for (priority = 8; mask; priority--, mask >>>= 1) {}
        }
        if (CPU.userMode) {
            setUserMode(0); // Change to kernel mode for interrupt (set accumulator set 0)
        }
        CPU.interruptMode = 1; // Set flag forinterrupt mode
        CPU.interruptSkip = 1; // Initialize interrupt skip control flag
        pi.coniStatus |= BIT20 >>> priority; // Set new interrupt priority level
        XCT(readWordFromExecTable(0o40 + 2 * priority), 0); // Execute an interrupt instruction
        if (!CPU.interruptSkip) {
            XCT(readWordFromExecTable(0o41 + 2 * priority), 0); // Second interrupt if needed
        }
        if (CPU.interruptMode) { // Check whether intruction restored the interrupt level
            pi.coniStatus &= ~(BIT20 >>> priority); // Set interrupt no longer in progress
            if (CPU.flags & flagUSR) {
                setUserMode(1); // Change back to user mode?
            }
            CPU.interruptMode = 0; // Terminate interrupt mode
        }
    }
}

function getPendingLights() {
    "use strict";
    var i, pendingLights = 0;
    for (i = CPU.interruptQueue.length; --i >= 0;) {
        if (CPU.interruptQueue[i].delay > 0) { // A non-zero delay count is end of loop
            break;
        }
        pendingLights |= BIT28 >>> CPU.interruptQueue[i].priority;
    }
    if (!pendingLights && !(pi.coniStatus & 0x7f00)) {
        pendingLights |= 0x80; // PI OK Light should be on
    }
    return pendingLights;
}


const
    RP03_SECT = 10,
    RP03_SURF = 20,
    RP03_CYL = 406;

var RP03 = {
    dataiStatus: BIT13 | BIT17 | BIT25, // Controller online, header locked, & type RP03
    coniStatus: 0o20000000, // 22 bit mode
    in22Bit: 1, // Flag for 22 bit addressing
    icwa: 0, // Initial control word address [IOWD]
    cwa: 0, // Control word address (points to NEXT control word)
    cwc: 0, // Control word count (2's complement of count)
    cma: 0, // Control memory address (points to last word written)
    completionWord: 0, // Completion control word
    selectedDrive: 0,
    busyDrive: 0,
    selectedCylinder: [0, 0, 0, 0, 0, 0, 0, 0], // Selected cylinder for each drive
    selectedSector: [0, 0, 0, 0, 0, 0, 0, 0], // Selected sector for each drive
    unit: [],
    postProcess: RP03_end
};



function RP03_writeCompletion() {
    "use strict";
    var completionWord;
    if (RP03.coniStatus & 0o20000000) { // Is controller in 18 or 22 bit mode?
        completionWord = RP03.cwa * BIT13 + RP03.cda;
    } else {
        completionWord = combine(RP03.cwa, RP03.cda);
    }
    writeWordByPhysical(RP03.icwa | 1, completionWord);
}

function RP03_coomplete() {
    RP03_writeCompletion();
    RP03.coniStatus |= BIT18; // Search complete
    RP03.coniStatus &= ~BIT31; // Controller is no longer busy
    RP03.coniStatus |= BIT32; // Done 
    return RP03.coniStatus;
}

function RP03_end(err, controller, drive, position, address, count) {
    switch (err) {
        case 1: // read error
            RP03.coniStatus |= BIT15; // Disk Sector Parity Error
            break;
        case 2: // NXM
            RP03.coniStatus |= BIT23; // NXM - No Such Memory Location
            break;
        case 3: // compare error
            RP03.coniStatus |= BIT15; // Disk Sector Parity Error
            break;
    }
    if (RP03.coniStatus & BIT31) { // Only proceed if busy set
        if (drive == RP03.busyDrive) {
            RP03.coniStatus |= BIT18; // Search complete
        }
        interrupt(1, 50, deviceDPC, RP03.coniStatus, RP03_coomplete);
        //}
    }
}

function RP03_seek(drive, cylinder) {
    if (RP03.coniStatus & BIT31) { // if drive busy defer seek end (says the manual!)
        setTimeout(RP03_seek, 4, drive, cylinder);
    } else {
        RP03.selectedCylinder[drive] = cylinder;
        RP03.dataiStatus |= BIT27 >>> drive; // Set appropriate attention flag
        if (drive == RP03.selectedDrive) {
            RP03.coniStatus &= ~BIT25; // Clear Disk not ready
        }
        RP03.coniStatus |= BIT32; // Done (set because attention set)
        interrupt(1, 0, deviceDPC, RP03.coniStatus);
    }
}

function RP03_dataoEnd() {
    if (!(RP03.coniStatus & BIT32)) { // If not already done
        RP03.coniStatus |= BIT32; // Done set 
        interrupt(1, 40, deviceDPC, RP03.coniStatus);
    }
}

var RP03_opName = ["read", "write", "read_verify", "write_header", "seek", "clear", "noop", "recalibrate"];

function ioDPC(ioCode, effectiveAddress) {
    "use strict";
    var operand, opCode, drive, cylinder, surface, sector, cda;
    switch (ioCode) {
        case CONO:
            operand = effectiveAddress;
            if (operand & BIT21) { // Clear search error
                RP03.coniStatus &= ~BIT21;
            }
            if (operand & BIT23) { // Clear no such memory (NXM)
                RP03.coniStatus &= ~BIT23;
            }
            if (operand & BIT26) { // Clear illegal write
                RP03.coniStatus &= ~BIT26;
            }
            if (operand & BIT27) { // Clear illegal datao
                RP03.coniStatus &= ~BIT27;
            }
            if (operand & BIT28) { // Clear sector error
                RP03.coniStatus &= ~BIT28;
            }
            if (operand & BIT29) { // Clear surface error
                RP03.coniStatus &= ~BIT29;
            }
            RP03.coniStatus = (RP03.coniStatus & ~7) | (operand & 7); // Set PI assignment
            if (operand & BIT30) { // Write control word
                RP03_writeCompletion();
                RP03.coniStatus |= BIT30; // Control word written
            }
            if (operand & BIT31) { // Stop operation and interrupt, clear busy, set done
                RP03.coniStatus &= ~BIT31; // Clear busy
                RP03.coniStatus |= BIT32; // Set done
                interrupt(1, 10, deviceDPC, RP03.coniStatus); // Replace any interrupts with new one
            }
            if (operand & BIT32) { // Clear done
                RP03.coniStatus &= ~BIT32; // Clear done
            }
            break;

        case DATAI:
            RP03.dataiStatus &= 0o00000776; // Only keep attentions
            if (RP03.selectedDrive > 3) {
                RP03.dataiStatus |= BIT15; // No such drive
                operand = RP03.selectedDrive * BIT2 + RP03.dataiStatus;
            } else {
                RP03.dataiStatus |= BIT13 | BIT17 | BIT25; // Drive online, header lockout & type RP03
                if (RP03.selectedCylinder[RP03.selectedDrive] >= 0) { // If not seek underway
                    RP03.dataiStatus |= BIT12; // On Cylinder
                    if (RP03.selectedCylinder[RP03.selectedDrive] >= 256) {
                        RP03.dataiStatus |= BIT24; // Add in cylinder 256 bit
                    }
                    RP03.dataiStatus |= RP03.selectedSector[RP03.selectedDrive] << 13;
                    operand = RP03.selectedDrive * BIT2 + (RP03.selectedCylinder[RP03.selectedDrive] & 0xff) * BIT10 + RP03.dataiStatus;
                } else {
                    operand = RP03.selectedDrive * BIT2 + RP03.dataiStatus; // Still seeking ... cylinder field empty?
                }
            }
            writeWordByVirtual(effectiveAddress, operand);
            break;

        case DATAO: // positioning operation or data transfer initiation
            // 0 read, 1 write, 2 read verify, 3 write with header, 4 seek, 5 clear attention, 6 noop, 7 recalibrate (seek 0)
            // DATAO clears Bits 14-17,21-24 and 26-30
            if (RP03.coniStatus & BIT31) { // If busy set
                RP03.coniStatus |= BIT27; // Illegal data0
                return;
            }
            if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
                RP03.coniStatus &= ~0x3c7be0; // Every legal datao clears the flags
                drive = Math.trunc(operand / BIT5) % 8;
                RP03.selectedDrive = drive;
                if (drive > 3) { // Ignore request entirely
                    return;
                }
                if (RP03.selectedCylinder[drive] < 0) { // Illegal drive or seek in progress
                    RP03.coniStatus |= BIT25; // Disk not ready
                    setTimeout(RP03_dataoEnd, 1);
                    return;
                } else {
                    RP03.coniStatus &= ~BIT25; // Clear Disk not ready
                }
                opCode = Math.trunc(operand / BIT2); // Get operations type
                if (opCode != 5 && opCode != 6) {
                    RP03.coniStatus &= ~BIT32; // Done clear 
                    RP03.coniStatus &= ~(BIT18 | BIT19 | BIT21 | BIT23 | BIT26 | BIT27 | BIT28 | BIT29);
                }
                cylinder = 0; // so logging statements work
                if (opCode < 5) { // Operations below 5 require the cylinder number
                    cylinder = Math.trunc(operand / BIT13) % 256;
                    if (Math.trunc(operand / BIT19) % 2) {
                        cylinder += 256; // Add in high cylinder bit
                    }
                    if (cylinder >= RP03_CYL) {
                        RP03.coniStatus |= BIT21; // Search error
                        RP03.dataiStatus &= ~BIT12; // Not on cylinder
                        RP03.coniStatus &= ~BIT32;
                        setTimeout(RP03_dataoEnd, 1);
                        return;
                    }
                }
                if (opCode < 4) { // Operations below 4 require cylinder check, surface number & sector
                    surface = Math.trunc(operand / BIT18) % 32;
                    if (surface >= RP03_SURF) {
                        RP03.coniStatus |= BIT29; // Surface error
                        RP03.coniStatus &= ~BIT32;
                        setTimeout(RP03_dataoEnd, 1);
                        return;
                    }
                    sector = Math.trunc(operand / BIT23) % 16;
                    if (sector >= RP03_SECT) {
                        RP03.coniStatus |= BIT28; // Sector error
                        RP03.coniStatus &= ~BIT32;
                        setTimeout(RP03_dataoEnd, 1);
                        return;
                    }
                    RP03.selectedSector[drive] = sector;
                    if (cylinder != RP03.selectedCylinder[drive]) { // Check after other checks!
                        RP03.coniStatus |= BIT21; // Search error
                        RP03.coniStatus &= ~BIT32;
                        setTimeout(RP03_dataoEnd, 1);
                        return;
                    }
                }
                switch (opCode) {
                    case 0: // Read
                    case 1: // Write
                        sector = ((cylinder * RP03_SURF) + surface) * RP03_SECT + sector;
                        RP03.icwa = operand & 0o776; // Get address of control words
                        RP03.cwa = RP03.icwa;
                        RP03.cwc = 0;
                        //RP03.coniStatus |= BIT30; // Control word transfer complete
                        if (typeof RP03.unit[drive] === "undefined") {
                            RP03.unit[drive] = {
                                "cache": [],
                                "maxblock": RP03_CYL * RP03_SURF * RP03_SECT,
                                "url": "dpa" + drive + ".dsk"
                            };
                        }
                        RP03.coniStatus |= BIT31; // Busy
                        RP03.coniStatus &= ~BIT32; // Not done
                        RP03.busyDrive = drive;
                        //setTimeout(diskIO, 1, (opCode ? 1 : 2), RP03, drive, sector * 128 * 8, cda, 128000, 0);
                        diskIO((opCode ? 1 : 2), RP03, drive, sector * 128 * 8, cda, 128000, 1);
                        return RP03.coniStatus; // Bypass command complete
                    case 7: // Recalibrate (seek to cylinder 0)
                        cylinder = 0; // Set cylinder to 0 and Fall Thru to seek
                    case 4: // Seek
                        RP03.coniStatus |= BIT25; // Disk not ready ... THIS MUST BE SET OR BOOTS FAILS
                        // RP03.coniStatus |= BIT31; // Busy should not set busy?
                        RP03.selectedCylinder[drive] = -1; // Not on cylinder
                        RP03.selectedSector[drive] = 0;
                        //RP03_seek(drive, cylinder);
                        setTimeout(RP03_seek, 4, drive, cylinder);
                        return RP03.coniStatus;
                    case 5: // Clear attentions
                        RP03.dataiStatus &= ~(operand & 0x1fe);
                        break;
                    case 2: // Read verify?
                    case 3: // Write with header
                        //default:
                        setTimeout(RP03_dataoEnd, 1);
                        break;
                }
                //RP03.coniStatus |= BIT32; // Done set 
                //interrupt(1, 0, deviceDPC, RP03.coniStatus);
            }
            break;
    }
    return RP03.coniStatus;
}

function mtc_complete(controller) {
    "use strict";
    var completionWord;
    mts.coniStatus |= BIT29 | BIT34; // set job done and load next unit
    interrupt(1, 0, deviceMTC, mtc.coniStatus >>> 3); // Odd that mtc priority is not in bits 33-35?
    if (mts.coniStatus & BIT9) { // Is controller in 18 or 22 bit mode?
        completionWord = mtc.cwc * BIT13 + mtc.cda;
    } else {
        completionWord = combine(mtc.cwc, mtc.cda);
    }
    writeWordByPhysical(mtc.icwa | 1, completionWord);
    if (DEBUG) {
        console.log("mtc_complete " + completionWord.toString(8) + " op:" + mtc.operation.toString(8) + " mtc:" + mtc.coniStatus.toString(8) + " mts:" + mts.coniStatus.toString(8) + " cda:" + mtc.cda.toString(8) + " cwc:" + mtc.cwc.toString(8) + " set job done and lnu");
    }
}

function mtc_end(err, controller, drive, position, address, count) {
    "use strict";
    var recordLen;
    switch (err) {
        case 1: // read error
            mts.coniStatus |= BIT13; // Tape Parity Error
            break;
        case 2: // NXM error
            mts.coniStatus |= BIT12; // NXM - No Such Memory Location
            break;
        case 3: // compare error
            mts.coniStatus |= BIT25; // Data comparison error
            break;
    }
    if (err === 0) {
        recordLen = controller.unit[drive].recordLen;
        console.log("record length:" + recordLen + " position:" + position + " op:" + mtc.operation.toString(8) + " mtc:" + mtc.coniStatus.toString(8) + " mts:" + mts.coniStatus.toString(8) + " cda:" + mtc.cda.toString(8) + " cwc:" + mtc.cwc.toString(8));
        mtc.unit[drive].driveStatus &= ~BIT20; // tape no longer at load point
        if (recordLen >= 0) { // Have just read tape record length
            if (recordLen === 0 || recordLen > 0x80000000) { // tape mark?
                controller.unit[drive].position = position; // Remember where the tape mark is
                mts.coniStatus |= BIT23; // Set EOF flag
                if (recordLen > 0x80000000) {
                    mts.coniStatus |= BIT23; // Set end point
                }
                mtc_complete(mtc);
            } else { // have got length of a tape record
                switch (mtc.operation) { // What were we doing again?
                    case 2: // read record
                    case 0o12: // read multi-record 
                    case 3: // read-compare record
                    case 0o13: // read-compare multi-record
                        mtc.partialByte = 0; // No word assembled thus far
                        mtc.unit[drive].position = position + 4 + ((recordLen + 1) & ~1);
                        mtc.unit[drive].recordLen = -1; // flag that we are reading data for callback
                        diskIO(4, controller, drive, position, 0, recordLen, 0);
                        return;
                    case 6: // Space records forward
                        mtc.unit[drive].position = position + 4 + ((recordLen + 1) & ~1); // Remember position and done
                        mtc_complete(mtc);
                        break;
                    case 0o16: // Space file forward
                        diskIO(0, mtc, drive, position + 4 + ((recordLen + 1) & ~1), 0, 2, 0); // Start reading next record length
                        return;
                    case 7: // Space records reverse
                        mtc.unit[drive].position = position - 8 - ((recordLen + 1) & ~1);
                        if (mtc.unit[drive].position <= 0) {
                            mtc.unit[drive].position = 0;
                        }
                        mtc_complete(mtc);
                        break;
                    case 0o17: // Space file reverse
                        position = position - 12 - ((recordLen + 1) & ~1);
                        if (position <= 0) {
                            mtc.unit[drive].position = 0;
                            mtc_complete(mtc);
                        } else {
                            diskIO(0, mtc, drive, position, 0, 2, 0); // Start reading previous record length
                        }
                        break;
                    default:
                        panic();
                }
            }
        } else { // Have just finished reading data - done unless multi-record
            switch (mtc.operation) { // What were we doing again?
                case 0o12: // read multi-record 
                case 0o13: // read-compare multi-record
                    diskIO(0, mtc, drive, mtc.unit[drive].position, 0, 2, 0);
                    return;
                    //}
                case 2: // read record
                case 3: // read-compare record
                    if (count < 0) {
                        mts.coniStatus |= BIT26; // Number of words was underestimated
                    } else {
                        mts.coniStatus &= ~BIT26;
                    }
                    mtc_complete(mtc);
                    //setTimeout(mtc_complete, 200, mtc);
                    break;
                default:
                    panic();
            }
        }
    }
}

var mtc = { // Magtape controller - a TM10B has two halves: mtc and mts
    coniStatus: 0, // TM10B
    icwa: 0, // initial control word address
    cwa: 0,
    cwc: 0,
    cda: 0,
    coredump: 0,
    recordLength: 0,
    operation: 0,
    in22Bit: 1, // Flag for 22 bit addressing
    partialByte: 0,
    partialData: 0,
    unit: [],
    postProcess: mtc_end
};

function ioMTC(ioCode, effectiveAddress) {
    "use strict";
    var drive, operation;
    switch (ioCode) {
        case CONO: // unit, parity, dump, function, nuie, density, priority flags, priority data
            drive = (effectiveAddress >>> 15) & 0x7;
            operation = (effectiveAddress >>> 9) & 0xf;
            if (drive > 2) {
                mts.coniStatus = BIT9; // clear status for no such unit
            } else {
                if (mts.coniStatus & BIT29) { // Ignore this command unless Job done
                    if (typeof mtc.unit[drive] === "undefined") { // if no drive data make some
                        mtc.unit[drive] = {
                            "cache": [],
                            "position": 0,
                            "recordLen": 0,
                            "url": "mta" + drive + ".tap"
                        };
                    }
                    mtc.coniStatus = effectiveAddress;
                    mts.coniStatus = BIT9 | BIT29 | BIT30 | BIT32 | BIT34; // 22 bit, job done, unit idle, write lock, load next unit
                    if (mtc.unit[drive].position == 0) {
                        mts.coniStatus |= BIT20; // tape at load point
                    } else {
                        if (mtc.unit[drive].recordLen == 0) {
                            mts.coniStatus |= BIT23; // Set EOF if last read was tape mark
                        } else {
                            if (mtc.unit[drive].recordLen >= 0x80000000) {
                                mts.coniStatus |= BIT23 | BIT24; // Set EOF and end point if end of tape file
                            }
                        }
                    }
                    switch ((mtc.coniStatus >>> 9) & 0xf) { // Start tape function
                        case 0: // noop
                            break;
                        case 0o10: // Interrupt when unit ready
                            if (!(mts.coniStatus & BIT34)) { // Ignore this command if LNU not set
                                mtc_complete(mtc); // Not happy with this - we can't handle multiple things active on controller
                            }
                            break;
                        case 1: // rewind
                        case 0o11: // rewind & unload
                            mtc.unit[drive].position = 0; // Rewind
                            mts.coniStatus |= BIT20; // tape at load point
                            mts.coniStatus &= ~(BIT23 | BIT24); // Clear EOF and end point
                            mtc_complete(mtc); // Fastest tape rewind you will ever see
                            break;
                        case 2: // read record
                        case 0o12: // read multi-record 
                        case 3: // read-compare record
                        case 0o13: // read-compare multi-record
                            mtc.cwc = 0; // initialize control word count
                            mtc.cwa = mtc.icwa; // set control word address
                            mtc.coredump = mtc.coniStatus & BIT22;
                            mtc.partialByte = 0; // No word assembled thus far
                        case 6: // Space records forward
                        case 0o16: // Space file forward
                            mtc.operation = operation;
                            mts.coniStatus &= ~(BIT29 | BIT30 | BIT34); //turn off Job done, idle & LNU
                            diskIO(0, mtc, drive, mtc.unit[drive].position, 0, 2, 0); // Start reading record length
                            break;
                        case 7: // Space records reverse
                        case 0o17: // Space file reverse
                            if (mtc.unit[drive].position > 0) {
                                mtc.operation = operation;
                                mts.coniStatus &= ~(BIT23 | BIT24); // Clear EOF and end point
                                mts.coniStatus &= ~(BIT29 | BIT30 | BIT34); //turn off Job done, idle & LNU
                                diskIO(0, mtc, drive, mtc.unit[drive].position - 4, 0, 2, 0); // Read last record length
                            } else {
                                mtc_complete(mtc); // Nothing to do if at start of tape?
                            }
                            break;
                        default:
                            mts.coniStatus |= BIT21; // Write protect error?
                            mtc_complete(mtc); // Done?
                            break;
                    }
                }
            }
            break;
        case DATAO:
            //if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
            //}
            break;
        case DATAI:
            writeWordByVirtual(effectiveAddress, mtc.partialData);
            if (mts.coniStatus & BIT29) { // Clear BR if job done
                mtc.partialData = 0;
            }
            break;
    }
    return mtc.coniStatus;
}

var mts = {
    coniStatus: BIT9 | BIT29 | BIT30 | BIT34 // Other half of TM10B 22 bit, idle
};

function ioMTS(ioCode, effectiveAddress) {
    "use strict";
    var operand;
    switch (ioCode) {
        case CONO: // clear, control word, move BR, stop
            if (effectiveAddress & BIT35) { // Move BR to HR and clear BR?
                mtc.partialData = 0;
            }
            break;
        case DATAO:
            if (DEBUG) {
                console.log(ioName[ioCode] + " MTS " + effectiveAddress.toString(8) + " mtc:" + mtc.coniStatus.toString(8) + " mts:" + mts.coniStatus.toString(8) + " @" + CPU.PC.toString(8));
            }
            if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
                mtc.icwa = operand & 0x1fe; // load ICWA
            }
            break;
        case DATAI:
            writeWordByVirtual(effectiveAddress, mts.BR);
            if (mts.coniStatus & BIT29) { // Clear BR if job done
                mtc.partialData = 0;
            }
            break;
    }
    return mts.coniStatus;
}

// TTY   24    25     26      27       28      29    30     31     32      33-35
// cono  test CinBsy CinDone CoutBsy COutDone inBsy inDone outBsy OutDone Priority
// coni  test                                 inBsy inDone outBsy OutDone Priority

var tty = {
    coniStatus: 0O00, // test(24) inBsy(29) inDone(30) outBsy(31) OutDone(32) Priority(33-35)
    inputChar: 0
};

function TTYsetDone() {
    "use strict";
    tty.coniStatus = (tty.coniStatus & ~BIT31) | BIT32; // clear output busy set output done
    return tty.coniStatus;
}

function ioTTY(ioCode, effectiveAddress) {
    "use strict";
    var operand = 0;
    switch (ioCode) {
        case CONO: // Set and clear input & output busy & done according to flags
            tty.coniStatus = ((tty.coniStatus & ~(effectiveAddress >>> 4)) & 0o170) | (effectiveAddress & 0o177);
            if (tty.coniStatus & (BIT30 | BIT32)) {
                interrupt(1, 1, deviceTTY, tty.coniStatus); //, TTYsetDone);
            }
            break;
        case DATAO: // Clear output done
            if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
                vt52Put(0, operand & 0x7f);
                tty.coniStatus = (tty.coniStatus | BIT31) & ~BIT32; // clear output done set busy
                interrupt(1, 100, deviceTTY, tty.coniStatus, TTYsetDone);
            }
            break;
        case DATAI: // Clear Input Done
            tty.coniStatus = tty.coniStatus & ~(BIT29 | BIT30); // clear input busy and input done
            writeWordByVirtual(effectiveAddress, tty.inputChar);
            break;
    }
    return tty.coniStatus; // Status for CONI / CONSZ / CONSO
}

// LPT   24    25    26    27    28    29    30-32    33-35
// cono       Init              Busy  Done  ErrorPri Priority
// coni  128   96        Error  Busy  Done  ErrorPri Priority

var lpt = { // LPT controller
    coniStatus: 0o0,
    textElement: null
};

function LPT_init() {
    "use strict";
    document.getElementById("lpt").innerHTML = '<p>printer<br /><textarea id=lpt_id cols=132 rows=24 spellcheck=false style="font-family:Liberation Mono,Monaco,Courier New,Lucida Console,Consolas,DejaVu Sans Mono,Bitstream Vera Sans Mono,monospace"></textarea><br /><button onclick="document.getElementById(' + "'lpt_id'" + ').value=' + "''" + ';">Clear</button></p>';
    lpt.textElement = document.getElementById("lpt_id");
}

function LPTsetDone() {
    "use strict";
    if (DEBUG) {
        console.log("SET FLAGS " + CPU.interruptMode + " q:" + CPU.interruptQueue.length + " cs:" + lpt.coniStatus.toString(8) + " pi:" + pi.coniStatus.toString(8) + " @" + CPU.PC.toString(8));
    }
    lpt.coniStatus = (lpt.coniStatus & ~BIT28) | BIT29; // clear Busy, set Done
    return lpt.coniStatus;
}

function ioLPT(ioCode, effectiveAddress) {
    "use strict";
    var i, ch, text, operand;
    switch (ioCode) {
        case CONO: // If bit 25 is 1, clear Done, set Busy
            if (DEBUG) {
                console.log("LPT CONO " + effectiveAddress.toString(8) + " q:" + CPU.interruptQueue.length + " cs:" + lpt.coniStatus.toString(8) + " pi:" + pi.coniStatus.toString(8) + " @" + CPU.PC.toString(8));
            }
            lpt.coniStatus = (effectiveAddress & 0o377) | BIT24;
            if ((effectiveAddress & BIT25)) {
                lpt.coniStatus = (lpt.coniStatus & ~BIT29) | BIT28; // clear Done, set Busy
                interrupt(1, 40, deviceLPT, lpt.coniStatus, LPTsetDone);
            } else {
                if ((effectiveAddress & BIT29)) { // if done
                    interrupt(1, 40, deviceLPT, lpt.coniStatus);
                } else {
                    interrupt(1, -1, deviceLPT, 0); // Clear interrupts
                }
            }
            break;
        case DATAO: // clear Done, set Busy, and trigger processing
            if (DEBUG) {
                console.log("LPT DATAO " + CPU.interruptMode + " q:" + CPU.interruptQueue.length + " cs:" + lpt.coniStatus.toString(8) + " pi:" + pi.coniStatus.toString(8) + " @" + CPU.PC.toString(8));
            }
            if (lpt.textElement == null) {
                LPT_init();
            }
            if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
                //if (lpt.coniStatus & BIT29) { // if done - is this really necessary?
                text = '';
                for (i = BIT6; i >= BIT34; i = Math.trunc(i / 128)) {
                    ch = (operand / i) & 0x7f;
                    if (ch > 0 && ch != 0o15) {
                        text += String.fromCharCode(ch);
                    }
                }
                if (text.length) {
                    lpt.textElement.value += text;
                }
                lpt.coniStatus = (lpt.coniStatus & ~BIT29) | BIT28; // clear Done, set Busy
                interrupt(1, 512, deviceLPT, lpt.coniStatus, LPTsetDone);
            }
            break;
    }
    return lpt.coniStatus; // Status for CONI / CONSZ / CONSO
}


var ptr = {
    coniStatus: 0
};

function ioPTR(ioCode, effectiveAddress) {
    "use strict";
    var operand;
    switch (ioCode) {
        case CONO:
            break;
        case CONI:
            break;
        case DATAO:
            if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
                updateAddressSwitches(right(operand));
                updateOperatingSwitches(left(operand) >>> 2, 7); // set address break, exec paging and user paging switches
            }
            break;
        case DATAI:
            break;
    }
    return ptr.coniStatus;
}

const serialNo = 514;

var pag = {
    coniStatus: 0O00,
    executiveStack: 0,
    dataiStatusLeft: 0,
    dataiStatusRight: 0
};

function ioPAG(ioCode, effectiveAddress) {
    "use strict";
    var operand;
    switch (ioCode) {
        case CONO:
            operand = effectiveAddress;
            pag.executiveStack = (operand >> 9) & 0x1f0; // Aligned for use as an address
            pag.coniStatus = (pag.coniStatus & 0x3ffe0) | (operand & 0x1f);
            //CPU.userMode = 0;
            break;
        case CONI:
            pag.coniStatus &= ~(BIT27 | BIT30);
            //if (!CPU.userMode) {
            //    pag.coniStatus |= BIT27;
            //}
            pag.coniStatus &= 0x1f;
            if (!CPU.lastMode) {
                pag.coniStatus |= BIT27;
            }
            if (CPU.lastVirtualAddress < 0) {
                pag.coniStatus |= BIT30; // Deleted word
            } else {
                pag.coniStatus |= (~CPU.lastVirtualAddress) & 0x3fe00;
            }
            break;
        case DATAO:
            if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
                if (operand & halfSign) { // Right word valid
                    CPU.execTable = (operand & 0x1fff) << 9; // Exec process table address
                    CPU.pageEnable = operand & 0o20000; // Bit 22 is page enable not trap enable as per older manuals
                    pag.dataiStatusRight = right(operand) & ~halfSign;
                }
                operand = left(operand);
                if (operand & halfSign) { // Left word valid
                    CPU.userTable = (operand & 0x1fff) << 9; // User process table address
                    CPU.smallUser = operand & 0o40000;
                    CPU.userRegisterSet = (operand >> 15) & 3;
                    if (CPU.userMode) {
                        setUserMode(1);
                    }
                    pag.dataiStatusLeft = operand & ~halfSign;
                }
                CPU.lastVirtualAddress = -1;
            }
            break;
        case DATAI:
            writeWordByVirtual(effectiveAddress, combine(pag.dataiStatusLeft, pag.dataiStatusRight));
            break;
    }
    return pag.coniStatus + (serialNo * BIT9);
}

// operating switches
// pi     0       1     2     3      4      5       6       7       8
// coni Ifetch Dfetch Write Astop Abreak Epaging Upaging PARstop NXMstop

// pi    11-17    21-26    28    29-35
// coni  ProgReq  InProg   On    Enabled

var pi = {
    coniStatus: 0O00
};

function ioPI(ioCode, effectiveAddress) {
    "use strict";
    var operand;
    switch (ioCode) {
        case CONO:
            operand = effectiveAddress;

            if (operand & BIT18) {
                apr.coniStatus &= ~BIT22; // Clear apr power failure flag
            }
            if (operand & BIT19) {
                apr.coniStatus &= ~BIT19; // Clear apr parity error flag
            }
            if (operand & BIT20) {
                apr.coniStatus &= ~BIT20; // Disable apr parity error interrupt
            }
            if (operand & BIT21) {
                apr.coniStatus |= BIT20; // Enable apr parity error interrupt
            }
            if (operand & BIT22) { // Drop Program requests on selected channels
                pi.coniStatus &= ~((operand & 0x7f) << 18); // Drop requests on selected levels
            }
            if (operand & BIT23) { // Clear PI system
                pi.coniStatus = 0; // Nuke status completely
                CPU.interruptQueue = [];
            }
            if (operand & BIT24) { // Initiate Program requests on selected channels
                pi.coniStatus |= (operand & 0x7f) << 18; // Inititiate interrupts on selected levels
            }
            if (operand & BIT25) { // Turn on selected channels
                pi.coniStatus |= (operand & 0x7f); // Turn on selected levels
            }
            if (operand & BIT26) { // Turn off selected channels
                pi.coniStatus &= ~(operand & 0x7f); // Turn off selected levels
            }
            if (operand & BIT27) { // Deactivate priority system
                pi.coniStatus &= ~BIT28; // Disable interrupts
            }
            if (operand & BIT28) { // Activate priority system
                pi.coniStatus |= BIT28; // Enable interrupts
            }
            CPU.checkInterruptFlag = 1;
            break;
    }
    return (panel.operatingSwitches * BIT8) + pi.coniStatus;
}

var apr = {
    coniStatus: 0 // BIT6 == 50Hz
};

function ioAPR(ioCode, effectiveAddress) {
    "use strict";
    var operand;
    switch (ioCode) {
        case CONO:
            operand = effectiveAddress;
            if (operand & BIT18) {
                // Reset timer! (what timer?)
            }
            if (operand & BIT19) {
                // Clear all io devices
            }
            if (operand & BIT20) {
                apr.coniStatus &= ~BIT21; // Disable timer
            }
            if (operand & BIT22) {
                apr.coniStatus &= ~BIT23; // Disable auto restart
            }
            if (operand & BIT24) {
                apr.coniStatus &= ~BIT25; // Disable clock interrupt
                interrupt(1, -1, deviceAPR, apr.coniStatus);
            }
            if (operand & BIT26) { // Clear clock
                interrupt(1, -1, deviceAPR, apr.coniStatus);
            }
            apr.coniStatus |= operand & (BIT21 | BIT23 | BIT25); // Enable timer, auto restart, and clock interrupt
            apr.coniStatus &= ~(BIT26 | BIT28 | BIT29); // Clear clock, in-out page fail, and nonexistant memory
            apr.coniStatus = (apr.coniStatus & ~0o77) | (operand & 0o77); // Insert priority interrupt for errors and clock
            break;
        case DATAO:
            if ((operand = readWordByVirtual(effectiveAddress)) >= 0) {
                updateDataSwitches(operand);
            }
            break;
        case DATAI:
            writeWordByVirtual(effectiveAddress, panel.dataSwitches);
            break;
    }
    return apr.coniStatus;
}

function clockInterrupt() {
    if (!CPU.halt && !(apr.coniStatus & BIT26)) {
        apr.coniStatus |= BIT26; // Set clock done
        if (apr.coniStatus & BIT25) { // If interrupt enabled do it
            interrupt(1, 0, deviceAPR, apr.coniStatus); // Create a clock interrupt (use APR device ID)
        }
    }
}

setInterval(clockInterrupt, 16);

const ioName = ["BLKI", "DATAI", "BLKO", "DATAO", "CONO", "CONI", "CONSZ", "CONSO"];

const
    BLKI = 0,
    DATAI = 1,
    BLKO = 2,
    DATAO = 3,
    CONO = 4,
    CONI = 5,
    CONSZ = 6,
    CONSO = 7;

const
    deviceAPR = 0o000 >>> 2,
    devicePI = 0o004 >>> 2,
    devicePAG = 0o010 >>> 2,
    devicePTP = 0o100 >>> 2,
    devicePTR = 0o104 >>> 2,
    deviceTTY = 0o120 >>> 2,
    deviceLPT = 0o124 >>> 2,
    deviceDPC = 0o250 >>> 2,
    deviceMTC = 0o340 >>> 2,
    deviceMTS = 0o344 >>> 2;

function deviceName(device) {
    switch (device) {
        case deviceAPR:
            return "APR";
        case devicePI:
            return "PI";
        case devicePAG:
            return "PAG";
        case deviceTTY:
            return "TTY";
        case deviceLPT:
            return "LPT";
        case deviceDPC:
            return "DPC";
        case deviceMTC:
            return "MTC";
        case deviceMTS:
            return "MTS";
        default:
            return "unknown";
    }
}

function ioOperation(instruction, AC, effectiveAddress, opCode) {
    "use strict";
    var ioDevice = Math.trunc(instruction / BIT9) % 128;
    var ioCode = Math.trunc(instruction / BIT12) % 8;
    var ioStatus, operand;
    //LOG_INSTRUCTION(instruction, AC, effectiveAddress, ioName[ioCode]);
    if (!ifPrivilege()) {
        UUO(opCode, AC, effectiveAddress, 0);
    } else {
        if (ioCode == BLKI || ioCode == BLKO) { // BLKI / BLKO handled by pre-processing
            if ((operand = readWordByVirtual(effectiveAddress)) < 0) {
                return;
            } else {
                operand = combine(left(operand) + 1, right(operand + 1));
                if (writeWordByVirtual(effectiveAddress, operand) < 0) {
                    return;
                } else {
                    skipSpecial(left(operand) != 0);
                    effectiveAddress = right(operand); // This becomes effectiveAddress for rest of operation
                }
            }
            if (ioCode == BLKO) {
                ioCode = DATAO; // convert BLKO to DATAO
            } else {
                ioCode = DATAI; // convert BLKI to DATAI
            }
        }
        switch (ioDevice) {
            case deviceAPR: // APR device 000
                ioStatus = ioAPR(ioCode, effectiveAddress);
                break;
            case devicePI: // PI  device 004
                ioStatus = ioPI(ioCode, effectiveAddress);
                break;
            case devicePAG: // PAG device 010
                ioStatus = ioPAG(ioCode, effectiveAddress);
                break;
            case devicePTR: // PTR device 104
                ioStatus = ioPTR(ioCode, effectiveAddress);
                break;
            case deviceTTY: // TTY device 120
                ioStatus = ioTTY(ioCode, effectiveAddress);
                break;
                //case deviceLPT: // LPT device 124
                //    ioStatus = ioLPT(ioCode, effectiveAddress);
                //    break;
            case deviceDPC: // DPC device 250 (RP03)
                ioStatus = ioDPC(ioCode, effectiveAddress);
                break;
            case deviceMTC: // MTC device 340 (TM11B)
                ioStatus = ioMTC(ioCode, effectiveAddress);
                break;
            case deviceMTS: // MTS device 344 (TM11B)
                ioStatus = ioMTS(ioCode, effectiveAddress);
                break;
            default:
                ioStatus = 0; // No such device (no idea what to do here! zero seems good)
                break;
        }
        switch (ioCode) { // Post processing for CONI / CONSZ / CONSO
            case CONI: // Return status bits
                writeWordByVirtual(effectiveAddress, ioStatus);
                break;
            case CONSZ: // Skip if all status mask bits are zero
                skipSpecial(((ioStatus & effectiveAddress) & halfMask) == 0);
                break;
            case CONSO: // Skip if any status mask bits are ones
                skipSpecial((ioStatus & effectiveAddress) & halfMask);
                break;
        }
    }
}