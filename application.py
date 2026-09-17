import os
import math
import sys

import cv2
import numpy
import PIL
import tensorflow as tf
from flask import Flask, request, jsonify
from flask_cors import CORS

from mrcnn.config import Config
from mrcnn.model import MaskRCNN


global _model
global _graph
global cfg
ROOT_DIR = os.path.abspath("./")
WEIGHTS_FOLDER = "./weights"

sys.path.append(ROOT_DIR)

MODEL_NAME = "mask_rcnn_hq"
WEIGHTS_FILE_NAME = 'maskrcnn_15_epochs.h5'

# A mask whose long axis is within this many degrees of horizontal or vertical is
# treated as axis-aligned, since almost all plans are drawn orthogonally.
AXIS_SNAP_DEGREES = 3

application=Flask(__name__)
cors = CORS(application, resources={r"/*": {"origins": "*"}})


class PredictionConfig(Config):
	# define the name of the configuration
	NAME = "floorPlan_cfg"
	# number of classes (background + door + wall + window)
	NUM_CLASSES = 1 + 3
	# simplify GPU config
	GPU_COUNT = 1
	IMAGES_PER_GPU = 1
	# Keep weaker detections too; clients filter by score (the viewer has a slider).
	DETECTION_MIN_CONFIDENCE = 0.5
	# Large plans have well over 100 wall segments.
	DETECTION_MAX_INSTANCES = 300

@application.before_first_request
def load_model():
	global cfg
	global _model
	model_folder_path = os.path.abspath("./") + "/mrcnn"
	weights_path= os.path.join(WEIGHTS_FOLDER, WEIGHTS_FILE_NAME)
	cfg=PredictionConfig()
	print(cfg.IMAGE_RESIZE_MODE)
	print('==============before loading model=========')
	_model = MaskRCNN(mode='inference', model_dir=model_folder_path,config=cfg)
	print('=================after loading model==============')
	_model.load_weights(weights_path, by_name=True)
	global _graph
	_graph = tf.get_default_graph()


def myImageLoader(imageInput):
	# the model expects 3 channels, so normalize grayscale, palette and RGBA inputs
	image = numpy.asarray(imageInput.convert('RGB'))
	h,w,c=image.shape
	return image,w,h

def getClassNames(classIds):
	result=list()
	for classid in classIds:
		data={}
		if classid==1:
			data['name']='wall'
		if classid==2:
			data['name']='window'
		if classid==3:
			data['name']='door'
		result.append(data)

	return result

def averageDoorSize(bbx,classIds):
	# Mean of each door's longer bbox side, in pixels. Clients use it to set the plan scale.
	sizes=[max(abs(bb[3]-bb[1]),abs(bb[2]-bb[0])) for bb,classid in zip(bbx,classIds) if classid==3]
	return sum(sizes)/len(sizes) if sizes else 0

def turnSubArraysToJson(objectsArr):
	result=list()
	for obj in objectsArr:
		data={}
		data['x1']=obj[1]
		data['y1']=obj[0]
		data['x2']=obj[3]
		data['y2']=obj[2]
		result.append(data)
	return result

def maskGeometry(mask,roi):
	"""Fits a detection's mask with a rectangle.

	Returns (bbox, shape): bbox is the tight axis-aligned [y1, x1, y2, x2] of the mask,
	shape is the oriented rectangle {cx, cy, length, thickness, angle} in pixels, where
	angle is the direction of the long side in degrees from +x (image y points down).
	Falls back to the model's roi when the mask is empty.
	"""
	contours,_=cv2.findContours(mask.astype(numpy.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
	contours=[c for c in contours if cv2.contourArea(c)>0]
	if not contours:
		y1,x1,y2,x2=[int(v) for v in roi]
		return [y1,x1,y2,x2],axisAlignedShape(x1,y1,x2,y2)

	largest=max(contours,key=cv2.contourArea)
	x,y,w,h=cv2.boundingRect(largest)
	bbox=[y,x,y+h,x+w]

	corners=cv2.boxPoints(cv2.minAreaRect(largest))
	edgeA=corners[1]-corners[0]
	edgeB=corners[2]-corners[1]
	longEdge,shortEdge=(edgeA,edgeB) if numpy.hypot(*edgeA)>=numpy.hypot(*edgeB) else (edgeB,edgeA)
	angle=math.degrees(math.atan2(longEdge[1],longEdge[0]))%180
	if min(angle,180-angle)<=AXIS_SNAP_DEGREES or abs(angle-90)<=AXIS_SNAP_DEGREES:
		return bbox,axisAlignedShape(x,y,x+w,y+h)

	center=corners.mean(axis=0)
	return bbox,{
		'cx':float(center[0]),
		'cy':float(center[1]),
		'length':float(numpy.hypot(*longEdge)),
		'thickness':float(numpy.hypot(*shortEdge)),
		'angle':float(angle),
	}

def axisAlignedShape(x1,y1,x2,y2):
	# Same orientation rule as the Unity client: the longer bbox side is the element's length.
	w=x2-x1
	h=y2-y1
	return {
		'cx':(x1+x2)/2,
		'cy':(y1+y2)/2,
		'length':float(max(w,h)),
		'thickness':float(min(w,h)),
		'angle':90.0 if h>w else 0.0,
	}



@application.route('/',methods=['GET'])
def viewer():
	return application.send_static_file('index.html')


@application.route('/',methods=['POST'])
def prediction():
	imagefile = PIL.Image.open(request.files['image'].stream)
	image,w,h=myImageLoader(imagefile)
	print(h,w)

	global _model
	global _graph
	# detect() resizes and subtracts the mean pixel itself, so it gets the raw RGB image.
	with _graph.as_default():
		r = _model.detect([image], verbose=0)[0]

	bbx=list()
	shapes=list()
	for i,roi in enumerate(r['rois']):
		bbox,shape=maskGeometry(r['masks'][:,:,i],roi)
		bbx.append(bbox)
		shapes.append(shape)

	data={}
	data['points']=turnSubArraysToJson(bbx)
	data['classes']=getClassNames(r['class_ids'])
	data['Width']=w
	data['Height']=h
	data['averageDoor']=averageDoorSize(bbx,r['class_ids'])
	data['scores']=r['scores'].tolist()
	data['shapes']=shapes
	return jsonify(data)


if __name__ =='__main__':
	application.debug=True
	print('===========before running==========')
	application.run()
	print('===========after running==========')
